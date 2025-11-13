// === CONFIGURATION ===

/**
 * Gets the PDF URL from the query string and wraps it in YOUR proxy
 * IMPORTANT: Don't encode the URL parameter - the proxy expects it raw
 */
function getPdfUrl() {
    // Replace this with YOUR actual Vercel deployment URL
    const YOUR_PROXY_URL = 'https://fuzzy-proxy-3ym45t58n-riteshs-projects-58a4d698.vercel.app/api/proxy?url=';
    
    const params = new URLSearchParams(window.location.search);
    const originalUrl = params.get('pdfurl');

    if (originalUrl && originalUrl.length > 0) {
        // DON'T encode again! The query param is already encoded by the bookmarklet
        const proxiedUrl = YOUR_PROXY_URL + originalUrl;
        
        console.log("Original PDF URL:", originalUrl);
        console.log("Proxied URL:", proxiedUrl);
        return proxiedUrl;
    }
    
    console.warn("No 'pdfurl' parameter found in URL. Loading local 'sample.pdf'.");
    return 'sample.pdf'; 
}

const PDF_URL = getPdfUrl(); 
const FUZZY_SEARCH_THRESHOLD = 0.4;

// Tell pdf.js where its worker file is
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.js';

// Get HTML elements
const PDF_CONTAINER = document.getElementById('pdf-container');
const STATUS_DISPLAY = document.getElementById('status');
const PAGE_COUNT_DISPLAY = document.getElementById('page-count');
const PAGE_NUMBER_INPUT = document.getElementById('page-number');
const BTN_PREV = document.getElementById('prev-page');
const BTN_NEXT = document.getElementById('next-page');
const BTN_GO = document.getElementById('go-page');
const RESULTS_PANEL = document.getElementById('results');

// Render state
let gPdf = null;
const renderedPages = new Set();
let renderQueue = Promise.resolve();

/**
 * Main function
 */
(async function main() {
    try {
        // 1. Get search term
        const searchTerm = getSearchTerm();
        if (!searchTerm) {
            STATUS_DISPLAY.textContent = "Ready. (Add ?text=your+quote to the URL to search)";
        } else {
            STATUS_DISPLAY.textContent = `Searching for: "${searchTerm}"...`;
        }

        // 2. Load PDF
        console.log("Loading PDF from:", PDF_URL);
        const pdf = await pdfjsLib.getDocument({
            url: PDF_URL,
            withCredentials: false
        }).promise;
        
        gPdf = pdf;     
        if (PAGE_COUNT_DISPLAY) PAGE_COUNT_DISPLAY.textContent = pdf.numPages;
        if (PAGE_NUMBER_INPUT) PAGE_NUMBER_INPUT.max = String(pdf.numPages);
        wireNavigation(pdf);
       
        STATUS_DISPLAY.textContent = "PDF loaded. Extracting text...";

        // 3. Extract text
        console.log("Extracting text from PDF...");
        const searchableCorpus = await extractTextCorpus(pdf);
        console.log(`Extracted ${searchableCorpus.length} lines of text.`);
        STATUS_DISPLAY.textContent = `Extracted ${searchableCorpus.length} lines. Searching...`;

        // 4. Fuzzy search
        let bestMatch = null;
        let topMatches = [];
        if (searchTerm) {
            const fuse = new Fuse(searchableCorpus, {
                keys: ['text'],
                threshold: FUZZY_SEARCH_THRESHOLD,
                includeScore: true,
                ignoreLocation: true,
                findAllMatches: true,
                minMatchCharLength: Math.min(3, searchTerm.length),
                distance: 1000,
            });

            let results = fuse.search(searchTerm);

            // Fallback: substring search
            if (results.length === 0) {
                const q = searchTerm.toLowerCase();
                const substrHits = searchableCorpus
                    .filter(line => line.text.toLowerCase().includes(q))
                    .map(line => ({ item: line, score: 0 }));
                results = substrHits;
            }

            if (results.length > 0) {
                topMatches = results.slice(0, 5);
                bestMatch = topMatches[0];
                console.log(`Top matches:`, topMatches.map(r => ({ page: r.item.pageNum, score: r.score })));
                STATUS_DISPLAY.textContent = `Found ${results.length} matches. Showing top ${topMatches.length}.`;
                renderResults(topMatches);
            } else {
                console.warn("No fuzzy match found.");
                STATUS_DISPLAY.textContent = `No good match found for "${searchTerm}".`;
            }
        }

        // 5. Render pages
        console.log("Rendering PDF pages...");
        if (bestMatch) {
            const matchPage = bestMatch.item.pageNum;
            await renderPage(pdf, matchPage, bestMatch);

            const targetPageId = `page-${matchPage}`;
            const targetElement = document.getElementById(targetPageId);
            if (targetElement) {
                console.log(`Scrolling to page ${matchPage}`);
                STATUS_DISPLAY.textContent = `Found on page ${matchPage}. Score: ${bestMatch.score.toFixed(3)}`;
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }

            setTimeout(async () => {
                for (let i = 1; i <= pdf.numPages; i++) {
                    if (i === matchPage) continue;
                    await renderPage(pdf, i, bestMatch);
                }
            }, 0);
        } else {
            for (let i = 1; i <= pdf.numPages; i++) {
                await renderPage(pdf, i, null);
            }
            if (searchTerm) {
                STATUS_DISPLAY.textContent = `No good match found for "${searchTerm}". Displaying PDF.`;
            } else {
                STATUS_DISPLAY.textContent = "PDF loaded. (No search term provided)";
            }
        }

    } catch (error) {
        console.error("Failed to load or process PDF:", error);
        
        let errorMsg = error.message || 'Unknown error';
        let errorDetails = '';
        
        // Check if it's a network/CORS error
        if (error.name === 'UnknownErrorException' || 
            errorMsg.toLowerCase().includes('cors') ||
            errorMsg.toLowerCase().includes('network')) {
            
            errorDetails = `
                <h3>Debugging steps:</h3>
                <ol>
                    <li>Open browser console (F12) and check for errors</li>
                    <li>Verify your proxy is deployed and working</li>
                    <li>Test your proxy directly: <a href="${YOUR_PROXY_URL}https://alex.smola.org/drafts/thebook.pdf" target="_blank">Test Proxy</a></li>
                    <li>Check if the original PDF URL is accessible</li>
                </ol>
            `;
        }
        
        STATUS_DISPLAY.textContent = `Error: ${errorMsg}`;
        PDF_CONTAINER.innerHTML = `
            <div style="background:white; padding:20px; border-radius:8px; max-width:700px; margin:20px;">
                <h2 style="color:red;">❌ Could not load PDF</h2>
                <p><strong>Error:</strong> ${errorMsg}</p>
                <p><strong>PDF URL:</strong> <code style="word-break:break-all;">${PDF_URL}</code></p>
                ${errorDetails}
            </div>
        `;
    }
})();

/**
 * Gets the search query from URL
 */
function getSearchTerm() {
    const params = new URLSearchParams(window.location.search);
    let q = params.get('text');
    if (q && q.length) {
        return decodeURIComponent(q.replace(/\+/g, ' ')).trim();
    }
    return null;
}

/**
 * Extract text from all pages
 */
async function extractTextCorpus(pdf) {
    const corpus = [];
    
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent({ normalizeWhitespace: true });
        
        let lines = [];
        let currentLine = null;
        
        for (const item of textContent.items) {
            const tx = item.transform;
            const x = tx[4];
            const y = tx[5];
            const w = item.width || 0;
            const h = (item.height != null) ? item.height : Math.max(Math.abs(tx[3]), 10);

            if (currentLine === null) {
                currentLine = { text: item.str, x, y, width: w, height: h, pageNum: i };
            } else if (Math.abs(currentLine.y - y) <= 3) {
                const rightEdge = Math.max(currentLine.x + currentLine.width, x + w);
                currentLine.width = rightEdge - currentLine.x;
                currentLine.text += ' ' + item.str;
                currentLine.height = Math.max(currentLine.height, h);
            } else {
                lines.push(currentLine);
                currentLine = { text: item.str, x, y, width: w, height: h, pageNum: i };
            }
        }
        if (currentLine) lines.push(currentLine);
        
        for (const line of lines) {
            const normalizedText = line.text.replace(/\s+/g, ' ').trim();
            if (normalizedText.length > 0) {
                corpus.push({
                    ...line,
                    text: normalizedText
                });
            }
        }
    }
    return corpus;
}


/**
* Renders a single PDF page with both a <canvas> and a <textLayer>
*/
async function renderPage(pdf, pageNum, bestMatch) {
    const page = await pdf.getPage(pageNum);
    const scale = 1.5;
    const viewport = page.getViewport({ scale });

    // Create a wrapper to hold the canvas, text, and highlights
    const pageWrapper = document.createElement('div');
    pageWrapper.id = `page-${pageNum}`;
    pageWrapper.className = 'page-wrapper';
    pageWrapper.style.width = `${viewport.width}px`;
    pageWrapper.style.height = `${viewport.height}px`;

    // Create canvas (the "picture" layer)
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    // Create the invisible text layer
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';

    // Append layers to the wrapper
    pageWrapper.appendChild(canvas);
    pageWrapper.appendChild(textLayerDiv);

    // Add the fully-built page to the document *before* rendering
    // This makes the page appear more quickly
    PDF_CONTAINER.appendChild(pageWrapper);

    // Get text content for this page
    const textContent = await page.getTextContent({ normalizeWhitespace: true });

    // Run render tasks in parallel for speed
    await Promise.all([
        page.render({
            canvasContext: context,
            viewport: viewport
        }).promise,
        pdfjsLib.renderTextLayer({
            textContent,
            container: textLayerDiv,
            viewport,
            textDivs: [],
            enhanceTextSelection: true
        }).promise
    ]);

    // Mark as rendered for navigation
    renderedPages.add(pageNum);

    // --- Highlighting Logic (now runs *after* layers are built) ---
    // Check if the best match is on THIS page
    if (bestMatch && bestMatch.item.pageNum === pageNum) {
        highlightMatch(pageWrapper, viewport, bestMatch.item);
    }
}

// --- Navigation helpers ---
async function ensurePageRendered(pageNum, bestMatch) {
    const id = `page-${pageNum}`;
    if (document.getElementById(id)) return; // already in DOM
    renderQueue = renderQueue.then(() => renderPage(gPdf, pageNum, bestMatch)).catch(err => console.error('Render failed:', err));
    await renderQueue;
}

async function scrollToPage(pageNum) {
    if (!gPdf) return;
    await ensurePageRendered(pageNum, null);
    const id = `page-${pageNum}`;
    const el = document.getElementById(id);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function wireNavigation(pdf) {
    if (!PAGE_NUMBER_INPUT) return;
    const clamp = (n) => Math.min(Math.max(n, 1), pdf.numPages);
    const getVal = () => clamp(parseInt(PAGE_NUMBER_INPUT.value || '1', 10));
    const setVal = (n) => { PAGE_NUMBER_INPUT.value = String(clamp(n)); };
    if (BTN_PREV) BTN_PREV.addEventListener('click', () => { const n = getVal(); setVal(n - 1); scrollToPage(n - 1); });
    if (BTN_NEXT) BTN_NEXT.addEventListener('click', () => { const n = getVal(); setVal(n + 1); scrollToPage(n + 1); });
    if (BTN_GO) BTN_GO.addEventListener('click', () => { const n = getVal(); scrollToPage(n); });
    PAGE_NUMBER_INPUT.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const n = getVal();
            scrollToPage(n);
        }
    });
}

/**
 * Render the top matches list and wire click handlers.
 */
function renderResults(matches) {
    if (!RESULTS_PANEL) return;
    if (!matches || matches.length === 0) {
        RESULTS_PANEL.innerHTML = '';
        return;
    }
    const html = [
        '<div><strong>Top Matches:</strong></div>',
        '<ul style="margin:6px 0; padding-left: 18px;">',
        ...matches.map((m, idx) => {
            const scoreStr = (m.score != null) ? m.score.toFixed(3) : '0.000';
            const textPreview = m.item.text.length > 160 ? m.item.text.slice(0, 157) + '…' : m.item.text;
            return `<li>
                <button class="result-link" data-page="${m.item.pageNum}" data-x="${m.item.x}" data-y="${m.item.y}" data-w="${m.item.width}" data-h="${m.item.height}" style="all:unset; color:#0060df; cursor:pointer;">
                    ${idx + 1}. Page ${m.item.pageNum} (score ${scoreStr}) — ${escapeHtml(textPreview)}
                </button>
            </li>`;
        }),
        '</ul>'
    ].join('');
    RESULTS_PANEL.innerHTML = html;
    // Wire clicks
    RESULTS_PANEL.querySelectorAll('.result-link').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const pageNum = parseInt(btn.dataset.page, 10);
            await scrollToPage(pageNum);
            // Highlight the specific match on that page
            const matchItem = {
                pageNum,
                x: parseFloat(btn.dataset.x),
                y: parseFloat(btn.dataset.y),
                width: parseFloat(btn.dataset.w),
                height: parseFloat(btn.dataset.h),
                text: ''
            };
            const wrapper = document.getElementById(`page-${pageNum}`);
            if (wrapper) {
                // Compute viewport from existing canvas size
                const canvas = wrapper.querySelector('canvas');
                const page = await gPdf.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.5 });
                highlightMatch(wrapper, viewport, matchItem);
            }
        });
    });
}

function escapeHtml(str) {
    return str.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}


/**
 * Creates and appends a <div> to highlight the matched text
 */
function highlightMatch(pageWrapper, viewport, matchItem) {
    const { x, y, width, height } = matchItem;

    // Use viewport rectangle conversion for correct top-left CSS positioning
    const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
    const left = Math.min(rect[0], rect[2]);
    const top = Math.min(rect[1], rect[3]);
    const w = Math.abs(rect[0] - rect[2]);
    const h = Math.abs(rect[1] - rect[3]);

    const highlight = document.createElement('div');
    highlight.className = 'highlight';
    highlight.style.left = `${left}px`;
    highlight.style.top = `${top}px`;
    highlight.style.width = `${w}px`;
    highlight.style.height = `${h}px`;

    console.log(`Highlighting on page ${matchItem.pageNum}: left=${left}, top=${top}, width=${w}, height=${h}`);
    pageWrapper.appendChild(highlight);
}
