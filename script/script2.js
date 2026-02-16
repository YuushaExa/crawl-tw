const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { promisify } = require('util');
const { default: PQueue } = require('p-queue');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

// ---- CONFIG ----
const WORKER_URL = 'https://curly-pond-9050.yuush.workers.dev';

// Helper: Resolve relative URL to absolute
function resolveUrl(relative, base) {
    try {
        return relative ? new URL(relative, base).href : '';
    } catch (e) {
        return relative || '';
    }
}

// Fetch all pages of author's works (handles pagination)
async function fetchAuthorWorks(axiosInstance, authorUrl, baseUrl, currentNovelId) {
    const allWorks = [];
    let currentPage = 1;
    const maxPages = 5; // Safety limit to prevent infinite loops

    while (currentPage <= maxPages) {
        try {
            const pageUrl = currentPage === 1 
                ? authorUrl 
                : `${authorUrl}?page=${currentPage}`;
            
            const response = await axiosInstance.get(pageUrl);
            const $ = cheerio.load(response.data);
            let foundItems = false;

            // Process each novel item
            $('li.burl').each((_, el) => {
                foundItems = true;
                const $item = $(el);
                
                // Get novel URL (prioritize image link)
                let novelPath = $item.find('div.l-img a').attr('href') || 
                               $item.find('h3.bname a').attr('href');
                
                if (!novelPath || !novelPath.startsWith('/read/')) return;
                
                // Skip current novel
                const idMatch = novelPath.match(/\/read\/(\d+)\//);
                if (!idMatch || idMatch[1] === currentNovelId) return;
                
                // Extract data
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

            // Stop if no items found (end of pagination)
            if (!foundItems) break;
            
            // Check for next page (look for pagination controls)
            const hasNextPage = $('.pager a').filter((_, el) => {
                return $(el).text().trim() === (currentPage + 1).toString() || 
                       $(el).hasClass('next');
            }).length > 0;
            
            if (!hasNextPage) break;
            currentPage++;
        } catch (error) {
            console.warn(`⚠️ Warning: Error processing author page ${currentPage}: ${error.message}`);
            break; // Stop pagination on error
        }
    }
    
    return allWorks;
}

// ---- NEW: Check Title and Save Metadata to Worker ----
async function checkAndSaveMetadata(metadata, axiosInstance) {
    try {
        console.log('🔍 Checking title against database...');
        
        // 1. Fetch existing titles
        const titlesRes = await axiosInstance.get(`${WORKER_URL}/titles.json`);
        if (!titlesRes.data) throw new Error('Failed to fetch titles.json');
        
        const existingTitles = titlesRes.data; // Expecting array of { title: "..." }
        const targetTitle = metadata.title.trim().toLowerCase();
        
        // 2. Check for duplicate
        const isDuplicate = existingTitles.some(item => 
            item.title && item.title.trim().toLowerCase() === targetTitle
        );
        
        if (isDuplicate) {
            console.log('⚠️  Duplicate detected! Title already exists in database. Skipping central save.');
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
        
        // 4. Send to Worker API
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
        console.warn(`⚠️  Metadata check/save failed: ${error.message}`);
        // Do not stop the crawl if this fails
        return false;
    }
}

async function crawlNovel(startUrl) {
    try {
        console.log(`Starting crawl for URL: ${startUrl}`);

        // Normalize URL
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
        console.log('Fetching novel page for metadata and chapter list...');
        const mainPageResponse = await axiosInstance.get(startUrl);
        const $main = cheerio.load(mainPageResponse.data);

        // --- Extract Metadata ---
        const novelTitle = $main('.n-text h1').first().text().trim() || 'Untitled';
        const cover = resolveUrl($main('.n-img img').attr('src'), baseUrl);
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

        // Generate chapter URLs
        const chapterUrls = Array.from({ length: latestChapter }, (_, i) =>
            `${baseUrl}/read/${novelId}/p${latestChapter - i}.html`
        );

        console.log(`Found ${chapterUrls.length} chapters. Novel: "${novelTitle}" by ${author}`);

        // === FETCH AUTHOR'S OTHER WORKS ===
        let otherworks = [];
        if (authorUrl) {
            try {
                console.log(`Fetching author page: ${authorUrl}`);
                otherworks = await fetchAuthorWorks(
                    axiosInstance, 
                    authorUrl, 
                    baseUrl, 
                    novelId
                );
                console.log(`✅ Extracted ${otherworks.length} other works from author page`);
            } catch (error) {
                console.warn(`⚠️ Warning: Failed to fetch author works: ${error.message}`);
            }
        } else {
            console.log('⚠️ No author URL found - skipping other works extraction');
        }

        // === NEW: CHECK TITLE & SAVE METADATA TO WORKER ===
        // Construct metadata object for checking
        const metaForCheck = {
            title: novelTitle,
            cover,
            author,
            authorUrl,
            status,
            description,
            genres
        };
        
        // Run check/save (does not block crawl if it fails)
        await checkAndSaveMetadata(metaForCheck, axiosInstance);

        // --- Prepare output directory ---
        const resultDir = path.join(__dirname, '../results');
        if (!fs.existsSync(resultDir)) {
            await mkdir(resultDir, { recursive: true });
        }

        const outputFile = path.join(resultDir, `${novelId}.json`);
        const chapters = [];

        // --- Download chapters ---
        const queue = new PQueue({ concurrency: 25 });
        let completed = 0;

        const updateProgress = () => {
            process.stdout.write(`\rDownloading: ${completed}/${chapterUrls.length} chapters`);
        };

        console.log('Starting chapter downloads...');
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

        // --- Final output with enhanced metadata ---
        const finalOutput = {
            meta: {
                id: novelId,
                title: novelTitle,
                cover,
                author,
                authorUrl,
                status,
                description,
                genres,
                totalChapters: filteredChapters.length,
                sourceUrl: startUrl,
                otherworks // Includes author's other works
            },
            chapters: filteredChapters
        };

        console.log('\n');
        await writeFile(outputFile, JSON.stringify(finalOutput, null, 2), 'utf8');
        console.log(`✅ Saved ${filteredChapters.length} chapters + metadata to ${outputFile}`);

        return outputFile;
    } catch (error) {
        console.error('\n❌ Crawl failed:', error.message);
        throw error;
    }
}

// --- Run ---
const url = process.argv[2] || process.env.INPUT_URL;
if (!url) {
    console.error('Usage: node crawler.js <novel-url>');
    console.error('Example: node crawler.js https://ixdzs.tw/read/617729/  ');
    process.exit(1);
}

crawlNovel(url)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
