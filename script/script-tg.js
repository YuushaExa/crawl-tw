const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { promisify } = require('util');
const { default: PQueue } = require('p-queue');
const archiver = require('archiver'); // Required for zipping

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink); // To clean up temp files if needed

// ---- CONFIG ----
const WORKER_URL = 'https://curly-pond-9050.yuush.workers.dev';
// Temporary folder for images before zipping
const TEMP_IMG_DIR = path.join(__dirname, '../temp_images'); 

// Helper: Resolve relative URL to absolute
function resolveUrl(relative, base) {
    try {
        return relative ? new URL(relative, base).href : '';
    } catch (e) {
        return relative || '';
    }
}

// Helper: Sanitize filename (remove invalid chars)
function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_').substring(0, 50);
}

// Helper: Download an image and save it
async function downloadImage(url, outputPath) {
    if (!url) return null;
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000
        });
        
        // Determine extension based on content-type or default to jpg
        let ext = 'jpg';
        const contentType = response.headers['content-type'];
        if (contentType && contentType.includes('png')) ext = 'png';
        if (contentType && contentType.includes('webp')) ext = 'webp';

        // Ensure output path has correct extension if we detected one different from default
        // For simplicity in this script, we force .jpg for cover and numbered files unless strictly needed
        // But let's stick to the requested naming: cover.jpg, 1.jpg etc. 
        // If the source is png, saving as .jpg might corrupt it. 
        // Better approach: Keep extension dynamic or convert. 
        // Here we will save with the detected extension but name it as requested + ext.
        
        const finalPath = `${outputPath}.${ext}`;
        
        await writeFile(finalPath, response.data);
        return path.basename(finalPath); // Return the filename used
    } catch (error) {
        console.warn(`⚠️ Failed to download image ${url}: ${error.message}`);
        return null;
    }
}

// Fetch all pages of author's works (handles pagination)
async function fetchAuthorWorks(axiosInstance, authorUrl, baseUrl, currentNovelId) {
    const allWorks = [];
    let currentPage = 1;
    const maxPages = 5; 

    while (currentPage <= maxPages) {
        try {
            const pageUrl = currentPage === 1 
                ? authorUrl 
                : `${authorUrl}?page=${currentPage}`;
            
            const response = await axiosInstance.get(pageUrl);
            const $ = cheerio.load(response.data);
            let foundItems = false;

            $('li.burl').each((_, el) => {
                foundItems = true;
                const $item = $(el);
                
                let novelPath = $item.find('div.l-img a').attr('href') || 
                               $item.find('h3.bname a').attr('href');
                
                if (!novelPath || !novelPath.startsWith('/read/')) return;
                
                const idMatch = novelPath.match(/\/read\/(\d+)\//);
                if (!idMatch || idMatch[1] === currentNovelId) return;
                
                const title = $item.find('h3.bname a').text().trim() || 'Untitled';
                const imgSrc = $item.find('div.l-img img').attr('src') || '';
                const description = $item.find('p.l-p2').text().trim() || '';
                
                allWorks.push({
                    title,
                    image: resolveUrl(imgSrc, baseUrl),
                    description,
                    url: resolveUrl(novelPath, baseUrl)
                });
            });

            if (!foundItems) break;
            
            const hasNextPage = $('.pager a').filter((_, el) => {
                return $(el).text().trim() === (currentPage + 1).toString() || 
                       $(el).hasClass('next');
            }).length > 0;
            
            if (!hasNextPage) break;
            currentPage++;
        } catch (error) {
            console.warn(`⚠️ Warning: Error processing author page ${currentPage}: ${error.message}`);
            break;
        }
    }
    
    return allWorks;
}

async function checkAndSaveMetadata(metadata, axiosInstance) {
    try {
        console.log('🔍 Checking title against database...');
        const titlesRes = await axiosInstance.get(`${WORKER_URL}/titles.json`);
        if (!titlesRes.data) throw new Error('Failed to fetch titles.json');
        
        const existingTitles = titlesRes.data;
        const targetTitle = metadata.title.trim().toLowerCase();
        
        const isDuplicate = existingTitles.some(item => 
            item.title && item.title.trim().toLowerCase() === targetTitle
        );
        
        if (isDuplicate) {
            console.log('⚠️ Duplicate detected! Skipping central save.');
            return false;
        } else {
            console.log('✅ Title is Original. Saving metadata to worker...');
        }
    
        const payload = {
            title: metadata.title,
            cover: metadata.cover,
            author: metadata.author,
            status: metadata.status,
            genres: metadata.genres,
            description: metadata.description,
            authorUrl: metadata.authorUrl
        };
        
        const saveRes = await axiosInstance.post(`${WORKER_URL}/api/saveMetadata`, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (saveRes.data && saveRes.data.success) {
            console.log('✅ Metadata saved successfully to worker.');
            return true;
        } else {
            throw new Error(saveRes.data.error || 'Worker returned failure');
        }
        
    } catch (error) {
        console.warn(`⚠️ Metadata check/save failed: ${error.message}`);
        return false;
    }
}

async function crawlNovel(startUrl) {
    let novelTitleSafe = "unknown_novel";
    let resultDir = path.join(__dirname, '../results');
    let zipPath = "";

    try {
        console.log(`Starting crawl for URL: ${startUrl}`);

        if (!startUrl.startsWith('http')) {
            startUrl = `https://${startUrl}`;
        }

        const novelIdMatch = startUrl.match(/\/read\/(\d+)/);
        if (!novelIdMatch) throw new Error('Invalid URL format: must contain /read/ followed by digits');
        const novelId = novelIdMatch[1];

        const baseUrl = new URL(startUrl).origin;
        const axiosInstance = axios.create({
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Connection': 'keep-alive'
            }
        });

        // === FETCH MAIN NOVEL PAGE ===
        console.log('Fetching novel page...');
        const mainPageResponse = await axiosInstance.get(startUrl);
        const $main = cheerio.load(mainPageResponse.data);

        // --- Extract Metadata ---
        const novelTitle = $main('.n-text h1').first().text().trim() || 'Untitled';
        novelTitleSafe = sanitizeFilename(novelTitle);
        const coverUrl = resolveUrl($main('.n-img img').attr('src'), baseUrl);
        const author = $main('.n-text p a.bauthor').first().text().trim() || 'Unknown';
        
        const authorUrlEl = $main('.n-text p a.bauthor').attr('href');
        const authorUrl = authorUrlEl ? resolveUrl(authorUrlEl, baseUrl) : null;

        let status = 'Unknown';
        if ($main('.n-text p .lz').length) {
            status = $main('.n-text p .lz').text().trim();
        } else if ($main('.n-text p .end').length) {
            status = $main('.n-text p .end').text().trim();
        }

        const description = $main('#intro').text().trim() || '';
        const genres = [];
        $main('.tags em a').each((_, el) => {
            const tag = $main(el).text().trim();
            if (tag) genres.push(tag);
        });

        // --- Extract latest chapter number ---
        const latestChapterUrl = $main('ul.u-chapter.cfirst li a').first().attr('href');
        if (!latestChapterUrl) throw new Error('Could not find any chapter links');
        const latestChapterMatch = latestChapterUrl.match(/p(\d+)\.html/);
        if (!latestChapterMatch) throw new Error('Could not extract chapter number from URL');
        const latestChapter = parseInt(latestChapterMatch[1], 10);

        const chapterUrls = Array.from({ length: latestChapter }, (_, i) =>
            `${baseUrl}/read/${novelId}/p${latestChapter - i}.html`
        );

        console.log(`Found ${chapterUrls.length} chapters. Novel: "${novelTitle}" by ${author}`);

        // === FETCH AUTHOR'S OTHER WORKS ===
        let otherworks = [];
        if (authorUrl) {
            try {
                console.log(`Fetching author page: ${authorUrl}`);
                otherworks = await fetchAuthorWorks(axiosInstance, authorUrl, baseUrl, novelId);
                console.log(`✅ Extracted ${otherworks.length} other works`);
            } catch (error) {
                console.warn(`⚠️ Warning: Failed to fetch author works: ${error.message}`);
            }
        }

        // === CHECK TITLE & SAVE METADATA TO WORKER ===
        const metaForCheck = {
            title: novelTitle,
            cover: coverUrl,
            author,
            authorUrl,
            status,
            description,
            genres
        };
        await checkAndSaveMetadata(metaForCheck, axiosInstance);

        // --- Prepare directories ---
        if (!fs.existsSync(resultDir)) {
            await mkdir(resultDir, { recursive: true });
        }
        
        // Create temp dir for images
        if (!fs.existsSync(TEMP_IMG_DIR)) {
            await mkdir(TEMP_IMG_DIR, { recursive: true });
        }

        // --- Download chapters ---
        const queue = new PQueue({ concurrency: 25 });
        let completed = 0;
        const chapters = [];

        const updateProgress = () => {
            process.stdout.write(`\rDownloading chapters: ${completed}/${chapterUrls.length}`);
        };

        console.log('\nStarting chapter downloads...');
        updateProgress();

        await Promise.all(chapterUrls.map((url, index) =>
            queue.add(async () => {
                try {
                    const response = await axiosInstance.get(url);
                    const $ = cheerio.load(response.data);

                    $('script, style, iframe, noscript, .abg, .ad, .ads, .hidden').remove();

                    let title = $('article.page-content > h3').first().text().trim() || '';
                    const paragraphs = [];
                    
                    $('article.page-content section p').each((_, el) => {
                        const $p = $(el);
                        if ($p.hasClass('abg') || $p.closest('.ad, .ads').length) return;
                        const htmlContent = $p.html();
                        if (htmlContent && htmlContent.trim().length > 0) {
                            paragraphs.push(`<p>${htmlContent.trim()}</p>`);
                        }
                    });

                    const chapterNumber = chapterUrls.length - index;
                    let content = paragraphs.join('\n');

                    if (!title && !content) return;
                    if (!content) content = "<p>Chapter is missing</p>";
                    if (!title) title = `Chapter ${chapterNumber}`;

                    chapters[chapterUrls.length - 1 - index] = {
                        title: title,
                        content: content
                    };
                } catch (error) {
                    console.error(`\nError downloading ${url}:`, error.message);
                } finally {
                    completed++;
                    updateProgress();
                }
            })
        ));

        const filteredChapters = chapters.filter(ch => ch !== undefined);
        console.log('\n✅ Chapters downloaded.');

        // === DOWNLOAD IMAGES ===
        console.log('🖼️ Downloading images...');
        
        // 1. Download Cover
        let coverFileName = null;
        if (coverUrl) {
            coverFileName = await downloadImage(coverUrl, path.join(TEMP_IMG_DIR, 'cover'));
        }

        // 2. Download Other Works Images
        const downloadedOtherWorksCount = [];
        if (otherworks.length > 0) {
            const imgQueue = new PQueue({ concurrency: 5 }); // Lower concurrency for images
            await Promise.all(otherworks.map((work, index) => 
                imgQueue.add(async () => {
                    if (work.image) {
                        // Name: 1.jpg, 2.jpg, etc.
                        const fileName = await downloadImage(work.image, path.join(TEMP_IMG_DIR, `${index + 1}`));
                        downloadedOtherWorksCount[index] = fileName;
                    }
                })
            ));
        }
        console.log('✅ Images downloaded.');

        // === REWRITE JSON PATHS ===
        // Update meta to point to local filenames inside the zip
        const finalMeta = {
            id: novelId,
            title: novelTitle,
            // If download succeeded, use filename, else keep original URL or null
            cover: coverFileName || coverUrl, 
            author,
            authorUrl,
            status,
            description,
            genres,
            totalChapters: filteredChapters.length,
            sourceUrl: startUrl,
            otherworks: otherworks.map((work, idx) => ({
                ...work,
                // Update image path if we downloaded it
                image: downloadedOtherWorksCount[idx] || work.image
            }))
        };

        const finalOutput = {
            meta: finalMeta,
            chapters: filteredChapters
        };

        // Write temporary JSON file to be added to zip
        const tempJsonPath = path.join(TEMP_IMG_DIR, 'data.json');
        await writeFile(tempJsonPath, JSON.stringify(finalOutput, null, 2), 'utf8');

        // === CREATE ZIP ===
        const zipFileName = `${novelTitleSafe}.zip`;
        zipPath = path.join(resultDir, zipFileName);
        
        console.log(`📦 Creating ZIP archive: ${zipFileName}...`);

        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', async () => {
                console.log(`✅ Archive created successfully: ${zipFileName} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`);
                
                // Cleanup temp images
                try {
                    const files = await fs.promises.readdir(TEMP_IMG_DIR);
                    for (const file of files) {
                        await fs.promises.unlink(path.join(TEMP_IMG_DIR, file));
                    }
                    // Optional: Remove directory if empty, though keeping it is fine for next run
                    // await fs.promises.rmdir(TEMP_IMG_DIR); 
                } catch (e) {
                    console.warn("⚠️ Could not clean up temp images:", e.message);
                }

                resolve(zipPath);
            });

            archive.on('error', (err) => {
                reject(err);
            });

            archive.pipe(output);

            // Add the JSON file as 'data.json' (or novelTitle.json if preferred, but data.json is standard)
            archive.file(tempJsonPath, { name: 'data.json' });

            // Add all images from temp directory
            // They will appear in the root of the zip alongside data.json
            archive.directory(TEMP_IMG_DIR, false);

            archive.finalize();
        });

    } catch (error) {
        console.error('\n❌ Crawl failed:', error.message);
        // Cleanup partial zip if exists
        if (zipPath && fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }
        throw error;
    }
}

// --- Run ---
const url = process.argv[2] || process.env.INPUT_URL;
if (!url) {
    console.error('Usage: node crawler.js <novel-url>');
    console.error('Example: node crawler.js https://ixdzs.tw/read/617729/');
    process.exit(1);
}

crawlNovel(url)
    .then(() => {
        console.log("🎉 All tasks completed!");
        process.exit(0);
    })
    .catch(() => process.exit(1));
