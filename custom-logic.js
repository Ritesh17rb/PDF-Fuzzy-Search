// === CONFIGURATION ===

/**
 * Gets the PDF URL from the query string (?pdfurl=...)
 * and wraps it in a CORS proxy to prevent security errors.
 * Falls back to 'sample.pdf' if not provided.
 */
function getPdfUrl() {
    // This free proxy fetches the PDF for us
    // and adds the correct "Access-Control-Allow-Origin" headers.
    // This is the new, working one
    const PROXY_URL = 'https://fuzzy-proxy-r6vj0p99b-riteshs-projects-58a4d698.vercel.app/?url=';
 
    const params = new URLSearchParams(window.location.search);
    const url = params.get('pdfurl');

    if (url && url.length > 0) {
        // We don't need to encode, just append the raw URL
        const proxiedUrl = PROXY_URL + url;
        
        console.log("Original PDF URL:", url);
        console.log("Using proxied URL:", proxiedUrl);
        return proxiedUrl;
    }
    
    console.warn("No 'pdfurl' parameter found in URL. Loading local 'sample.pdf'.");
    // This will now only load if you visit your GitHub page directly
    // AND you have 'sample.pdf' uploaded to your repo.
    return 'sample.pdf'; 
}

// Get the URL to load from the function above
const PDF_URL = getPdfUrl(); 

// How "fuzzy" to be (0.0 = perfect match, 1.0 = any match). 
// 0.4 is a good starting point.
const FUZZY_SEARCH_THRESHOLD = 0.4;


// Tell pdf.js where its "worker" file is
// This path should be correct since your file is in 'lib/pdf.worker.js'
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.js';

// Get our HTML elements from index.html
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
 * Main function to run everything
 */
(async function main() {
    try {
        // 1. Get the search term from the URL (supports ?text=... or #?text=...)
        const searchTerm = getSearchTerm();
        if (!searchTerm) {
            STATUS_DISPLAY.textContent = "Ready. (Add #?text=your+quote to the URL to search)";
        } else {
            STATUS_DISPLAY.textContent = `Searching for: "${searchTerm}"...`;
        }

        // 2. Load the PDF document
        const pdf = await pdfjsLib.getDocument(PDF_URL).promise;
        gPdf = pdf;     
        if (PAGE_COUNT_DISPLAY) PAGE_COUNT_DISPLAY.textContent = pdf.numPages;
        if (PAGE_NUMBER_INPUT) PAGE_NUMBER_INPUT.max = String(pdf.numPages);
        wireNavigation(pdf);
       
        STATUS_DISPLAY.textContent = "PDF loaded. Extracting text...";

        // 3. Extract text from ALL pages into a searchable "corpus"
        console.log("Extracting text from PDF...");
        const searchableCorpus = await extractTextCorpus(pdf);
        console.log(searchableCorpus)
        console.log(`Extracted ${searchableCorpus.length} lines of text.`);
        STATUS_DISPLAY.textContent = `Extracted ${searchableCorpus.length} lines. Searching...`;

        // 4. Run the fuzzy search
        let bestMatch = null;
        let topMatches = [];
        if (searchTerm) {
            // We need fuse.min.js for this. Make sure it's in your index.html
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
            // console.log(`Results: ${results}`)

            // Fallback: simple substring if no fuzzy results
            if (results.length === 0) {
                const q = searchTerm.toLowerCase();
                const substrHits = searchableCorpus
                    .filter(line => line.text.toLowerCase().includes(q))
                    .map(line => ({ item: line, score: 0 }));
                results = substrHits;
            }

            if (results.length > 0) {
                // Top 5 matches
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

        // 5. Render pages with priority on the matched page
        console.log("Rendering PDF pages...");
        if (bestMatch) {
            const matchPage = bestMatch.item.pageNum;
            // Render matched page first for fast highlight
            await renderPage(pdf, matchPage, bestMatch);

            // Scroll immediately to the matched page
            const targetPageId = `page-${matchPage}`;
            const targetElement = document.getElementById(targetPageId);
            if (targetElement) {
                console.log(`Scrolling to page ${matchPage}`);
                STATUS_DISPLAY.textContent = `Found on page ${matchPage}. Score: ${bestMatch.score.toFixed(3)}`;
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }

            // Render the remaining pages in the background (sequential to save memory)
            setTimeout(async () => {
                for (let i = 1; i <= pdf.numPages; i++) {
                    if (i === matchPage) continue;
                    await renderPage(pdf, i, bestMatch);
                }
            }, 0);
        } else {
            // No match: render sequentially
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
        // Check if this is a CORS error
        let errorMsg = error.message;
        if (error.name === 'UnknownErrorException' || (error.message && error.message.toLowerCase().includes('cors'))) {
            errorMsg = `CORS Error: The PDF server at '${PDF_URL.replace('https://corsproxy.io/?', '')}' does not allow requests, even from a proxy. Some PDFs are locked down and cannot be loaded. (See console for details.)`;
            console.error(errorMsg);
        }
        STATUS_DISPLAY.textContent = `Error: ${errorMsg}. Check console.`;
        PDF_CONTAINER.innerHTML = `<h2 style="color: red;">Error: Could not load PDF.</h2><p>${errorMsg}</p><p>The URL being loaded was: <strong>${PDF_URL}</strong></p>`;
    }
})();

/**
 * Gets the search query from the URL hash
 * e.g., ...index.html#?text=this+is+my+quote
 */
function getSearchTerm() {
    // Prefer query string (?text=...), but support hash (#?text=...)
    const params = new URLSearchParams(window.location.search);
    let q = params.get('text');
    if (q && q.length) {
        return decodeURIComponent(q.replace(/\+/g, ' ')).trim();
    }

    const hash = window.location.hash;
    if (hash.startsWith('#?text=')) {
        return decodeURIComponent(hash.substring(7).replace(/\+/g, ' ')).trim();
    }
    return null;
}

/**
 * Loops through all pages, extracts text, and builds a
 * searchable array of objects.
 * This is the most complex part. It tries to reconstruct lines.
 */
async function extractTextCorpus(pdf) {
    const corpus = [];
    
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent({ normalizeWhitespace: true });
        
        // We'll store lines as objects with their text and location
        let lines = [];
        let currentLine = null;
        
        for (const item of textContent.items) {
            const tx = item.transform;
            const x = tx[4];
            const y = tx[5];
            const w = item.width || 0;
            // Approximate text height from transform scale if not provided
            const h = (item.height != null) ? item.height : Math.max(Math.abs(tx[3]), 10);

            if (currentLine === null) {
                currentLine = { text: item.str, x, y, width: w, height: h, pageNum: i };
            } else if (Math.abs(currentLine.y - y) <= 3) { // Same line (tolerance)
                // If this item appears to be to the right, extend the width
                const rightEdge = Math.max(currentLine.x + currentLine.width, x + w);
                currentLine.width = rightEdge - currentLine.x;
                currentLine.text += ' ' + item.str;
                // Keep the tallest glyph height in the line
                currentLine.height = Math.max(currentLine.height, h);
            } else { // New line
                lines.push(currentLine);
                currentLine = { text: item.str, x, y, width: w, height: h, pageNum: i };
            }
        }
        if (currentLine) lines.push(currentLine); // Push last line
        
        // Clean up and add to corpus
        for (const line of lines) {
             // Normalize text: replace multiple spaces with one, and trim
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
