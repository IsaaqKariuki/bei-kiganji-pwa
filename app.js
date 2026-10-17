// Stored in localStorage so they survive page reloads.
function getSettings() {
    return{
        url:    localStorage.getItem('bk_url')  || '',
        token:  localStorage.getItem('bk_token') || '',
        admin:  localStorage.getItem('bk_admin')    || '',
    };
}

function openSettings(){
    const s = getSettings();
    document.getElementById('cfgUrl').value = s.url;
    document.getElementById('cfgToken').value = s.token;
    document.getElementById('cfgAdmin').value = s.admin;
    document.getElementById('settings').style.display = 'flex';
}

function closeSettings(e) {
// close if backdrop clicked, or close button, or no event at all
if (!e || e.target.id === 'settings'){
    document.getElementById('settings').style.display = 'none';
 }
}

function saveSettings () {
    const rawUrl = document.getElementById('cfgUrl').value.trim();
    const cleanUrl = rawUrl.replace(/\/+$/, '');
    localStorage.setItem('bk_url', cleanUrl);
    localStorage.setItem('bk_token', document.getElementById('cfgToken').value.trim());
    localStorage.setItem('bk_admin', document.getElementById('cfgAdmin').value.trim());
    closeSettings();
    showAdminPanel();
    syncNow(); // immediately pull latest products
}

// IndexedDB Helpers
// openDB() -open (or creates) the database
// upsertProducts()-save a batch of products, overwriting by id
// allProducts() -returns every n0n-deleted products

const DB_NAME = 'bkDB';
const DB_VERSION =1;
const STORE = 'products';

// OpenDB() returns a  promise that resolves to the database object.
// We wrap the callback-based IndexedDB API in a Promise so we can use await
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        // here we define the structure (like CREATE TABLE in SQL).
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                //Keypath: 'id' means each record is identified by its id field.
                const store = db.createObjectStore(STORE, { keyPath: 'id' });
                store. createIndex('name', 'name', { unique:false});
            }
        };

        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

// upsertProducts(products) - saves an array of products
// "upsert" = insert if new, update if already exists.
// this is how the sync works: the server sends changed rows and we overwrite them
async function upsertProducts(products) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx =db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        products.forEach(p => store.put(p));
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

// Sync ENgine
// We store the timestamp of the last successful sync in localStorage
// 0 means "never synced" - give me everything
function getLastSync() {
    return localStorage.getItem('bk_lastSync') || '1970-01-01T00:00:00.000Z';
}
function setLastSync(ts) {
    localStorage.setItem('bk_lastSync', ts);
}

async function syncNow() {
    const { url, token, admin } = getSettings();
    if (!url) {
        setSyncBar('⚙️ Tap the gear to set your backend URL');
        return;
    }

    setSyncBar('Syncing...');

    // Build the auth header: admin key takes priority, then share the token
    const headers = {};
    if (admin) headers['x-admin-key']  =admin;
    else if (token) headers['x-share-token'] = token;

    try {
        const since = getLastSync();
        const res = await fetch (`${url}/api/changes?since=${since}`,{ headers });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setSyncBar(`⚠️ Sync Failed: ${body.error || res.status}`);
            return;
        }

        const { changes, serverTime } = await res.json();

        if (changes.length > 0) {
            await upsertProducts(changes); // save all changed rows to IndexedDB
        }

        // Always use the server's clock for the next sync timestamp
        // not the phone's clock
        setLastSync(serverTime);
        
        setSyncBar(
            changes.length > 0
            ? ` Synced ${changes.length} change(s) - ${fmt(serverTime)}`
            : `Up to date - ${fmt(serverTime)}`
        );

        const q = document.getElementById('searchInput').value;
        onSearch(q);
    } catch (err) {
        setSyncBar(`📵 Offline - last sync ${fmt(getLastSync())}`);
    }
}

// Format an ISO timestamp into something readable like "Mon 13 Oct 14:30"
function fmt(ts) {
    if (!ts || ts === '0') return 'never';
    return new Date(ts).toLocaleString('en-KE', {
        weekday: 'short', day: 'numeric',month: 'short',
        hour: '2-digit', minute: '2-digit'
    });
}

function setSyncBar(msg) {
    document.getElementById('syncBar').textContent = msg;
}

// SEARCH & DISPLAY PRODUCTS
async function onSearch(query = '') {
    const q = (query || '').trim().toLowerCase();
    const all = await allProducts(); // get all local products from indexedDB

    const hits = q
        ? all.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.category && p.category.toLowerCase().includes(q))
          )
        : all;

    renderProductList(hits, Boolean(q), query);
}

function renderProductList(items, isSearch, query = '') {
    const container = document.getElementById('results');
    if (!items || items.length === 0) {
        if (isSearch) {
            container.innerHTML = `<div class="empty">No products found for "${esc(query)}".<br>Try a different spelling.</div>`;
        } else {
            container.innerHTML = `<div class="empty">📦 No products available yet.<br><small style="color:#6B7280">Upload a CSV or wait for sync to finish.</small></div>`;
        }
        return;
    }

    const countHeader = `<div style="font-size:12px;color:#6B7280;margin-bottom:2px;font-weight:500">
        ${isSearch ? `Found ${items.length} product(s) matching "${esc(query)}"` : `All Products (${items.length})`}
    </div>`;

    const cardsHtml = items.map(p => `
        <div class="card">
            <div>
                <div class="card-name">${esc(p.name)}</div>
                <div class="card-cat">${esc(p.category || '-')}${p.quantity != null ? ` • Stock: ${p.quantity}` : ''}</div>
            </div>
            <div>
                <div class="card-price">Ksh ${num(p.retail_price)}</div>
                ${isOwner() ? `<div class="card-entry">Cost: Ksh ${num(p.entry_price)}</div>` : ''}
            </div>
        </div>
    `).join('');

    container.innerHTML = countHeader + cardsHtml;
}

// is Owner() - true if admin key is set (owner sees cost prices too)
function isOwner() {
    return Boolean(getSettings().admin);
}
// esc () -escape HTML special character to prevent XSS
// (never insert user-controlled text directly into innerHTML)
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// num() - format a number as e.g "1,450.00"
function num(n) {
    return n == null
        ? '-'
        : Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2 });
}
// allProducts () -returns every non-deleted product from the IndexedDB sorted alphabetically
async function allProducts() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.getAll();
        req.onsuccess = () => {
            const active = (req.result || []).filter(p => !p.is_deleted);
            active.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
            resolve(active);
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

// ADMIN PANEL
function showAdminPanel() {
    const panel = document.getElementById('adminPanel');
    if (isOwner()) {
        panel.style.display = 'block';
        loadShareLinks();
    } else {
        panel.style.display = 'none';
    }
}

async function uploadCSV() {
    const { url, admin } = getSettings();
    const file = document.getElementById('csvFile').files[0];
    const status = document.getElementById('csvStatus');

    if (!file) { status.textContent = ' Choose a CSV file first.'; return; }
    if (!admin) { status.textContent = 'The ADMIN key has not been set in settings.'; return; }

    status.textContent = 'Uploading... ';

    const  form = new FormData();
    form.append('file', file);

    try {
        const res = await fetch (`${url}/api/products/upload`,{
            method: 'POST',
            headers: { 'x-admin-key': admin},
            body: form,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error (data.error || res.status);
        status.textContent = `Inserted ${data.inserted} products (${data.skipped} skipped). Syncing...`;
        // reset the lastSync so the new products come down
        localStorage.removeItem('bk_lastSync');
        await syncNow();
    } catch (err) { 
        status.textContent =  `${err.message}`;
    }
}

async function createShareLink() {
    const { url, admin } = getSettings();
    const label = document.getElementById('shareLabel').value.trim();
    const result = document.getElementById('shareResult');

    if (!admin) { result.textContent = 'Admin key not set.'; return;}

    try {
        let res = await fetch(`${url}/api/share-links`, {
            method: 'POST',
            headers: { 'x-admin-key': admin, 'Content-Type': 'application/json'},
            body:JSON.stringify({ label }),
        });
        // Fallback to /api/share if Render has not finished deploying /share-links
        if (res.status === 404) {
            res = await fetch(`${url}/api/share`, {
                method: 'POST',
                headers: { 'x-admin-key': admin, 'Content-Type': 'application/json'},
                body:JSON.stringify({ label }),
            });
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.status);

        const shareUrl = url
            ? `${window.location.origin}${window.location.pathname}?token=${data.token}&url=${encodeURIComponent(url)}`
            : `${window.location.origin}${window.location.pathname}?token=${data.token}`;
        
        result.innerHTML = `
            <div style="margin-top:10px;padding:12px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;box-sizing:border-box">
                <div style="margin-bottom:6px">Token: <strong>${esc(data.token)}</strong></div>
                <div style="font-size:12px;color:#4B5563;word-break:break-all;margin-bottom:10px">
                    <a href="${esc(shareUrl)}" target="_blank">${esc(shareUrl)}</a>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn-primary" style="font-size:13px;padding:7px 14px"
                        data-url="${esc(shareUrl)}" onclick="copyShareUrl(this.dataset.url, this)">📋 Copy Link</button>
                    ${navigator.share ? `<button class="btn btn-ghost" style="font-size:13px;padding:7px 14px"
                        data-url="${esc(shareUrl)}" data-label="${esc(label || 'Bei Kiganjani')}"
                        onclick="shareNative(this.dataset.url, this.dataset.label)">↗️ Share</button>` : ''}
                </div>
            </div>`;
        
        // Auto-copy to clipboard immediately upon generation
        copyShareUrl(shareUrl, null);

        loadShareLinks();
    } catch (err) {
        result.textContent = `${err.message}`;
    }
}

async function copyShareUrl(text, btn) {
    let success = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            success = true;
        } catch (e) {
            success = fallbackCopy(text);
        }
    } else {
        success = fallbackCopy(text);
    }

    if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = success ? '✅ Copied!' : '❌ Copy failed';
        setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
}

function fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

async function shareNative(shareUrl, label) {
    if (navigator.share) {
        try {
            await navigator.share({
                title: label || 'Bei Kiganjani',
                text: 'Access Bei Kiganjani shop prices:',
                url: shareUrl,
            });
        } catch (e) {
            // User cancelled share
        }
    }
}

async function loadShareLinks() {
    const { url, admin } = getSettings();
    const list = document.getElementById('shareList');
    if (!admin || !url) return;

    try {
        let res = await fetch (`${url}/api/share-links`,{
            headers: {'x-admin-key': admin },
        });
        if (res.status === 404) {
            res = await fetch (`${url}/api/share`,{
                headers: {'x-admin-key': admin },
            });
        }
        let data = await res.json().catch(() => null);
        if (data && data.links && Array.isArray(data.links)) {
            data = data.links;
        }
        if (!res.ok || !Array.isArray(data)) return;

        if (data.length === 0) {
            list.innerHTML = '<p style="font-size:13px;color:#6B7280">No share links yet.</p>';
            return;
        }

        list.innerHTML = '<strong style="font-size:13px">Existing links</strong>' +
            data.map(l => {
                const linkUrl = url
                    ? `${window.location.origin}${window.location.pathname}?token=${l.token}&url=${encodeURIComponent(url)}`
                    : `${window.location.origin}${window.location.pathname}?token=${l.token}`;
                return `
                <div class="card" style="flex-direction:column;align-items:flex-start;gap:6px;margin-top:8px;font-size:13px">
                    <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
                        <strong>${esc(l.label || '(no label)')}</strong>
                        <span style="color:${l.is_revoked ? '#DC2626' : '#16A34A'};font-weight:600">${l.is_revoked ? 'Revoked' : 'Active'}</span>
                    </div>
                    <div><code>${esc(l.token)}</code></div>
                    ${!l.is_revoked ? `
                        <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
                            <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px"
                                data-url="${esc(linkUrl)}" onclick="copyShareUrl(this.dataset.url, this)">📋 Copy Link</button>
                            ${navigator.share ? `<button class="btn btn-ghost" style="font-size:12px;padding:5px 10px"
                                data-url="${esc(linkUrl)}" data-label="${esc(l.label || 'Bei Kiganjani')}"
                                onclick="shareNative(this.dataset.url, this.dataset.label)">↗️ Share</button>` : ''}
                            <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px;color:#DC2626"
                                onclick="revokeLink('${l.token}')">Revoke</button>
                        </div>` : ''}
                </div>`;
            }).join('');
    }catch (e) {/* Offline*/}
}


async function revokeLink(token) {
    const { url, admin } = getSettings();
    if (!confirm ('Revoke this link? Staff using it will lose access.')) return;
    try {
        let res = await fetch (`${url}/api/share-links/${token}`,{
            method: 'DELETE',
            headers: { 'x-admin-key': admin },
        });
        if (res.status === 404) {
            res = await fetch (`${url}/api/share/${token}`,{
                method: 'DELETE',
                headers: { 'x-admin-key': admin },
            });
        }
        if (res.ok) loadShareLinks();
    }catch (e) { alert('Could not revoke - are you offline?');}
}

// STARTUP
// Auto-import token or backend URL if opened via a share link
const urlParams = new URLSearchParams(window.location.search);
const sharedToken = urlParams.get('token');
const sharedUrl = urlParams.get('url');
if (sharedToken) localStorage.setItem('bk_token', sharedToken.trim());
if (sharedUrl) localStorage.setItem('bk_url', sharedUrl.trim().replace(/\/+$/, ''));

// When the page loads: render cached products, sync immediately, then sync every 60 seconds
showAdminPanel();
onSearch('');
syncNow();
setInterval(syncNow, 60_000);

// Register the service worker step 13
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
}
