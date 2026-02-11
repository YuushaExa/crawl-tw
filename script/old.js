const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { promisify } = require('util');
const { default: PQueue } = require('p-queue');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

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

        // === FETCH THE MAIN PAGE (which contains both metadata AND chapter list) ===
        console.log('Fetching novel page for metadata and chapter list...');
        const mainPageResponse = await axiosInstance.get(startUrl);
        const $main = cheerio.load(mainPageResponse.data);

        // --- Extract Metadata ---
        const novelTitle = $main('.n-text h1').first().text().trim() || 'Untitled';
        const cover = $main('.n-img img').attr('src') || '';
        const author = $main('.n-text p a.bauthor').first().text().trim() || 'Unknown';

        const authorUrlEl = $main('.n-text p a.bauthor').attr('href');
        const authorUrl = authorUrlEl ? new URL(authorUrlEl, startUrl).href : null;

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

        // Generate chapter URLs from 1 to latestChapter (but download from latest → 1)
        const chapterUrls = Array.from({ length: latestChapter }, (_, i) =>
            `${baseUrl}/read/${novelId}/p${latestChapter - i}.html`
        );

        console.log(`Found ${chapterUrls.length} chapters. Novel: "${novelTitle}" by ${author}`);

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

                    // Clean unwanted elements (like the browser script does)
                    $('script, style, iframe, noscript, .abg, .ad, .ads, .hidden').remove();

                    // Extract title - preserve as-is like browser script
                    let title = $('article.page-content > h3').first().text().trim() || '';

                    // Extract paragraphs - PRESERVE HTML STRUCTURE like the browser script
                    const paragraphs = [];
                    $('article.page-content section p').each((_, el) => {
                        const $p = $(el);
                        // Skip unwanted paragraphs (same filters as browser script)
                        if ($p.hasClass('abg') || $p.closest('.ad').length || $p.closest('.ads').length) {
                            return;
                        }
                        
                        // Get the HTML content of the paragraph, preserving formatting
                        const htmlContent = $p.html();
                        if (htmlContent && htmlContent.trim().length > 0) {
                            paragraphs.push(`<p>${htmlContent.trim()}</p>`);
                        }
                    });

                    const chapterNumber = chapterUrls.length - index;

                    // Build content with preserved HTML structure (like browser script)
                    let content = paragraphs.join('\n');

                    if (!title && !content) {
                        return; // skip empty
                    }
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

        // --- Final output with metadata ---
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
                sourceUrl: startUrl
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
    console.error('Example: node crawler.js https://ixdzs.tw/read/620883/');
    process.exit(1);
}

crawlNovel(url)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
