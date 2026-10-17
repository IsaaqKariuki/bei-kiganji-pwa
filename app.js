// Stored in localStorage so they survive page reloads.
function getSettings() {
    return {
        url:   localStorage.getItem('bk_url')   || '',
        token: localStorage.getItem('bk_token') || '',
        admin: localStorage.getItem('bk_admin') || '',
    };
}

function isOwner() {
    return Boolean(getSettings().admin);
}

// ── Settings Modal ──
function openSettings() {
    const s = getSettings();
    document.getElementById('cfgUrl').value = s.url;
    document.getElementById('cfgToken').value = s.token;
    document.getElementById('cfgAdmin').value = s.admin;
    document.getElementById('settings').classList.add('open');
}

function closeSettings(e) {
    if (!e || e.target.id === 'settings') {
        document.getElementById('settings').classList.remove('open');
    }
}

function saveSettings() {
    const rawUrl = document.getElementById('cfgUrl').value.trim();
    const cleanUrl = rawUrl.replace(/\/+$/, '');
    localStorage.setItem('bk_url', cleanUrl);
    localStorage.setItem('bk_token', document.getElementById('cfgToken').value.trim());
    localStorage.setItem('bk_admin', document.getElementById('cfgAdmin').value.trim());
    
    document.getElementById('settings').classList.remove('open');
    showOwnerTabs();
    onSearch('');
    syncNow();
}

// ── Tab Navigation ──
function switchTab(name, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    
    if (btn) btn.classList.add('active');
    else {
        const t = document.getElementById(`tab-${name}`);
        if (t) t.classList.add('active');
    }

    const targetView = document.getElementById(`view-${name}`);
    if (targetView) targetView.classList.add('active');

    if (name === 'search') {
        const q = document.getElementById('searchInput').value;
        onSearch(q);
    } else if (name === 'admin') {
        renderAdminView();
    } else if (name === 'links') {
        loadShareLinks();
    }
}

function showOwnerTabs() {
    const tabBar = document.getElementById('tabBar');
    if (isOwner()) {
        tabBar.style.display = 'flex';
    } else {
        tabBar.style.display = 'none';
        switchTab('search', document.getElementById('tab-search'));
    }
}

// ── IndexedDB Helpers ──
const DB_NAME = 'bkDB';
const DB_VERSION = 1;
const STORE = 'products';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id' });
                store.createIndex('name', 'name', { unique: false });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function upsertProducts(products) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        products.forEach(p => store.put(p));
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

async function allProducts(includeDeleted = false) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.getAll();
        req.onsuccess = () => {
            let list = req.result || [];
            if (!includeDeleted) {
                list = list.filter(p => !p.is_deleted);
            }
            list.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
            resolve(list);
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

// ── Sync Engine ──
function getLastSync() {
    return localStorage.getItem('bk_lastSync') || '1970-01-01T00:00:00.000Z';
}

function setLastSync(ts) {
    localStorage.setItem('bk_lastSync', ts);
}

function setSyncBar(msg, status = 'ok') {
    document.getElementById('syncBar').textContent = msg;
    const dot = document.getElementById('syncDot');
    dot.className = 'sync-dot';
    if (status === 'syncing') dot.classList.add('syncing');
    else if (status === 'offline') dot.classList.add('offline');
}

function fmtDate(ts) {
    if (!ts || ts === '0') return 'never';
    return new Date(ts).toLocaleString('en-KE', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit'
    });
}

async function syncNow() {
    const { url, token, admin } = getSettings();
    if (!url) {
        setSyncBar('⚙️ Set backend URL in settings', 'offline');
        return;
    }

    setSyncBar('Syncing…', 'syncing');

    const headers = {};
    if (admin) headers['x-admin-key'] = admin;
    else if (token) headers['x-share-token'] = token;

    try {
        const since = getLastSync();
        const res = await fetch(`${url}/api/changes?since=${encodeURIComponent(since)}`, { headers });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setSyncBar(`⚠️ Sync Failed: ${body.error || res.status}`, 'offline');
            return;
        }

        const { changes, serverTime } = await res.json();

        if (changes && changes.length > 0) {
            await upsertProducts(changes);
        }

        setLastSync(serverTime);

        setSyncBar(
            changes && changes.length > 0
                ? `Synced ${changes.length} change(s) · ${fmtDate(serverTime)}`
                : `Up to date · ${fmtDate(serverTime)}`,
            'ok'
        );

        // Refresh views with newly synced data
        const q = document.getElementById('searchInput').value;
        onSearch(q);

        if (isOwner()) {
            renderAdminView();
        }
    } catch (err) {
        setSyncBar(`Offline · last sync ${fmtDate(getLastSync())}`, 'offline');
    }
}

// ── Search & Catalog View ──
async function onSearch(query = '') {
    const q = (query || '').trim().toLowerCase();
    const all = await allProducts(false);

    const hits = q
        ? all.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.category && p.category.toLowerCase().includes(q))
          )
        : all;

    renderSearchResults(hits, Boolean(q), query);
}

function renderSearchResults(items, isSearch, query = '') {
    const container = document.getElementById('searchResults');
    if (!items || items.length === 0) {
        if (isSearch) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📭</div>
                    <h3>No products found for "${esc(query)}"</h3>
                    <p>Try searching with another spelling or category name.</p>
                </div>`;
        } else {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📦</div>
                    <h3>No products synced yet</h3>
                    <p>Products will appear here once uploaded by the shop owner.</p>
                </div>`;
        }
        return;
    }

    const countHeader = `
        <div style="font-size:12px;color:var(--fg-2);margin-bottom:8px;font-weight:600">
            ${isSearch ? `Found ${items.length} product(s) for "${esc(query)}"` : `All Products (${items.length})`}
        </div>`;

    const cardsHtml = items.map(p => `
        <div class="product-card">
            <div class="prod-left">
                <div class="prod-name">${esc(p.name)}</div>
                <div class="prod-meta">
                    <span class="chip">${esc(p.category || 'General')}</span>
                    ${renderStockChip(p.quantity)}
                </div>
            </div>
            <div class="prod-right">
                <div class="retail-price">Ksh ${num(p.retail_price)}</div>
                ${isOwner() && p.entry_price != null ? `<div class="cost-price">Cost: Ksh ${num(p.entry_price)}</div>` : ''}
            </div>
        </div>
    `).join('');

    container.innerHTML = countHeader + cardsHtml;
}

function renderStockChip(qty) {
    if (qty == null) return '';
    if (qty === 0) return '<span class="chip warn">Out of stock</span>';
    if (qty < 5) return `<span class="chip warn">Low: ${qty}</span>`;
    return `<span class="chip ok">Qty: ${qty}</span>`;
}

// ── Admin View (Owner Only) ──
async function renderAdminView() {
    if (!isOwner()) return;

    const all = await allProducts(true);
    const active = all.filter(p => !p.is_deleted);

    // Update stats strip
    const totalCount = active.length;
    const lowCount = active.filter(p => (p.quantity || 0) < 5).length;
    const cats = new Set(active.map(p => p.category).filter(Boolean)).size;

    document.getElementById('statTotal').textContent = totalCount;
    document.getElementById('statLow').textContent = lowCount;
    document.getElementById('statCats').textContent = cats;

    // Render manage products list
    const container = document.getElementById('adminProductList');
    if (all.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div><h3>No products</h3><p>Upload a CSV file to add products.</p></div>';
        return;
    }

    container.innerHTML = all.map(p => `
        <div class="product-card ${p.is_deleted ? 'deleted' : ''}">
            <div class="prod-left">
                <div class="prod-name">${esc(p.name)}</div>
                <div class="prod-meta">
                    <span class="chip">${esc(p.category || 'General')}</span>
                    ${p.is_deleted ? '<span class="chip warn">Deleted</span>' : renderStockChip(p.quantity)}
                </div>
                <div class="card-actions">
                    ${p.is_deleted ? `
                        <button class="btn-sm btn-restore" onclick="restoreProduct(${p.id})">Restore</button>
                    ` : `
                        <button class="btn-sm btn-edit" onclick="openEdit(${p.id})">Edit</button>
                        <button class="btn-sm btn-delete" onclick="openDelete(${p.id}, '${esc(p.name).replace(/'/g, "\\'")}')">Delete</button>
                    `}
                </div>
            </div>
            <div class="prod-right">
                <div class="retail-price">Ksh ${num(p.retail_price)}</div>
                ${p.entry_price != null ? `<div class="cost-price">Cost: Ksh ${num(p.entry_price)}</div>` : ''}
            </div>
        </div>
    `).join('');
}

// ── CSV Upload ──
function onFileSelected(input) {
    if (!input.files || !input.files[0]) return;
    const status = document.getElementById('csvStatus');
    status.style.color = 'var(--fg-2)';
    status.textContent = `${input.files[0].name} selected — press Upload`;
}

// Setup Drag & Drop Zone
document.addEventListener('DOMContentLoaded', () => {
    const zone = document.getElementById('fileDropZone');
    if (!zone) return;

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.style.borderColor = 'var(--accent)';
    });

    zone.addEventListener('dragleave', () => {
        zone.style.borderColor = '';
    });

    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.style.borderColor = '';
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
            const input = document.getElementById('csvFile');
            input.files = e.dataTransfer.files;
            onFileSelected(input);
        }
    });
});

async function uploadCSV() {
    const { url, admin } = getSettings();
    const file = document.getElementById('csvFile').files[0];
    const status = document.getElementById('csvStatus');

    if (!file) {
        status.style.color = 'var(--warn)';
        status.textContent = 'Please choose a CSV file first.';
        return;
    }
    if (!admin) {
        status.style.color = 'var(--warn)';
        status.textContent = 'Admin key not set in settings.';
        return;
    }

    status.style.color = 'var(--fg-2)';
    status.textContent = 'Uploading CSV…';

    const form = new FormData();
    form.append('file', file);

    try {
        const res = await fetch(`${url}/api/products/upload`, {
            method: 'POST',
            headers: { 'x-admin-key': admin },
            body: form,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        status.style.color = 'var(--ok)';
        status.textContent = `✓ Inserted ${data.inserted} products (${data.skipped} skipped). Syncing…`;

        localStorage.removeItem('bk_lastSync');
        await syncNow();
        document.getElementById('csvFile').value = '';
    } catch (err) {
        status.style.color = 'var(--warn)';
        status.textContent = `Upload failed: ${err.message}`;
    }
}

// ── Soft-Delete Confirmation Sheet ──
let pendingDeleteId = null;

function openDelete(id, name) {
    pendingDeleteId = id;
    document.getElementById('deleteModalText').textContent =
        `"${name}" will be removed from the price list. Staff won't see it. You can restore it any time from Admin tools.`;
    document.getElementById('deleteModal').classList.add('open');
}

function closeDelete() {
    document.getElementById('deleteModal').classList.remove('open');
    pendingDeleteId = null;
}

function closeDeleteOnBackdrop(e) {
    if (e.target.id === 'deleteModal') {
        closeDelete();
    }
}

async function confirmDelete() {
    if (pendingDeleteId == null) return;
    const { url, admin } = getSettings();
    const idToDelete = pendingDeleteId;
    closeDelete();

    try {
        const res = await fetch(`${url}/api/products/${idToDelete}`, {
            method: 'DELETE',
            headers: { 'x-admin-key': admin },
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(`Could not delete: ${data.error || res.status}`);
            return;
        }

        // Optimistically mark deleted in local IndexedDB
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.get(idToDelete);
        req.onsuccess = () => {
            if (req.result) {
                req.result.is_deleted = 1;
                store.put(req.result);
            }
        };

        await syncNow();
    } catch (err) {
        alert('Could not delete product — check connection.');
    }
}

// ── Restore Product ──
async function restoreProduct(id) {
    const { url, admin } = getSettings();
    try {
        const res = await fetch(`${url}/api/products/${id}/restore`, {
            method: 'POST',
            headers: { 'x-admin-key': admin },
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(`Could not restore: ${data.error || res.status}`);
            return;
        }

        // Optimistically mark restored in local IndexedDB
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.get(id);
        req.onsuccess = () => {
            if (req.result) {
                req.result.is_deleted = 0;
                store.put(req.result);
            }
        };

        await syncNow();
    } catch (err) {
        alert('Could not restore product — check connection.');
    }
}

// ── Edit Product Dialog ──
async function openEdit(id) {
    const all = await allProducts(true);
    const p = all.find(x => x.id === id);
    if (!p) return;

    document.getElementById('editProdId').value = p.id;
    document.getElementById('editName').value = p.name || '';
    document.getElementById('editCategory').value = p.category || '';
    document.getElementById('editQuantity').value = p.quantity ?? 0;
    document.getElementById('editEntryPrice').value = p.entry_price ?? '';
    document.getElementById('editRetailPrice').value = p.retail_price ?? '';
    document.getElementById('editStatus').textContent = '';

    document.getElementById('editModal').classList.add('open');
}

function closeEdit() {
    document.getElementById('editModal').classList.remove('open');
}

function closeEditOnBackdrop(e) {
    if (e.target.id === 'editModal') closeEdit();
}

async function saveProductEdit() {
    const { url, admin } = getSettings();
    const id = parseInt(document.getElementById('editProdId').value, 10);
    const status = document.getElementById('editStatus');

    const body = {
        name: document.getElementById('editName').value.trim(),
        category: document.getElementById('editCategory').value.trim() || null,
        quantity: parseInt(document.getElementById('editQuantity').value, 10) || 0,
        entry_price: parseFloat(document.getElementById('editEntryPrice').value) || null,
        retail_price: parseFloat(document.getElementById('editRetailPrice').value) || null,
    };

    if (!body.name) {
        status.style.color = 'var(--warn)';
        status.textContent = 'Product name is required.';
        return;
    }

    status.style.color = 'var(--fg-2)';
    status.textContent = 'Saving changes…';

    try {
        const res = await fetch(`${url}/api/products/${id}`, {
            method: 'PUT',
            headers: {
                'x-admin-key': admin,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.status);

        closeEdit();
        await syncNow();
    } catch (err) {
        status.style.color = 'var(--warn)';
        status.textContent = `Save failed: ${err.message}`;
    }
}

// ── Share Links View ──
async function createShareLink() {
    const { url, admin } = getSettings();
    const label = document.getElementById('shareLabel').value.trim();
    const result = document.getElementById('shareResult');

    if (!admin) {
        result.style.color = 'var(--warn)';
        result.textContent = 'Admin key not set in settings.';
        return;
    }

    try {
        let res = await fetch(`${url}/api/share-links`, {
            method: 'POST',
            headers: { 'x-admin-key': admin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ label }),
        });

        // Fallback to /api/share if needed
        if (res.status === 404) {
            res = await fetch(`${url}/api/share`, {
                method: 'POST',
                headers: { 'x-admin-key': admin, 'Content-Type': 'application/json' },
                body: JSON.stringify({ label }),
            });
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.status);

        const shareUrl = url
            ? `${window.location.origin}${window.location.pathname}?token=${data.token}&url=${encodeURIComponent(url)}`
            : `${window.location.origin}${window.location.pathname}?token=${data.token}`;

        result.innerHTML = `
            <div style="margin-top:10px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
                <div style="margin-bottom:6px">Token: <code style="font-family:var(--mono)">${esc(data.token)}</code></div>
                <div style="font-size:12px;color:var(--fg-2);word-break:break-all;margin-bottom:10px">
                    <a href="${esc(shareUrl)}" target="_blank" style="color:var(--accent)">${esc(shareUrl)}</a>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn-primary" style="width:auto;font-size:12px;padding:6px 14px"
                        data-url="${esc(shareUrl)}" onclick="copyShareUrl(this.dataset.url, this)">📋 Copy Link</button>
                    ${navigator.share ? `
                        <button class="btn-ghost" style="font-size:12px;padding:6px 14px"
                            data-url="${esc(shareUrl)}" data-label="${esc(label || 'Bei Kiganjani')}"
                            onclick="shareNative(this.dataset.url, this.dataset.label)">↗️ Share</button>
                    ` : ''}
                </div>
            </div>`;

        // Automatically copy to clipboard upon generation
        copyShareUrl(shareUrl, null);
        document.getElementById('shareLabel').value = '';
        loadShareLinks();
    } catch (err) {
        result.style.color = 'var(--warn)';
        result.textContent = `Error: ${err.message}`;
    }
}

async function loadShareLinks() {
    const { url, admin } = getSettings();
    const list = document.getElementById('shareList');
    if (!admin || !url) return;

    try {
        let res = await fetch(`${url}/api/share-links`, {
            headers: { 'x-admin-key': admin },
        });

        if (res.status === 404) {
            res = await fetch(`${url}/api/share`, {
                headers: { 'x-admin-key': admin },
            });
        }

        let data = await res.json().catch(() => null);
        if (data && data.links && Array.isArray(data.links)) {
            data = data.links;
        }

        if (!res.ok || !Array.isArray(data)) return;

        if (data.length === 0) {
            list.innerHTML = '<p style="font-size:13px;color:var(--fg-2);padding:10px 0">No share links yet.</p>';
            return;
        }

        list.innerHTML = data.map(l => {
            const linkUrl = url
                ? `${window.location.origin}${window.location.pathname}?token=${l.token}&url=${encodeURIComponent(url)}`
                : `${window.location.origin}${window.location.pathname}?token=${l.token}`;
            const isActive = !l.is_revoked;

            return `
                <div class="share-row">
                    <div class="share-left">
                        <div class="share-label">
                            ${esc(l.label || '(no label)')}
                            <span class="chip ${isActive ? 'ok' : 'warn'}" style="font-size:10px">${isActive ? 'Active' : 'Revoked'}</span>
                        </div>
                        <div class="share-token">${esc(l.token)}</div>
                    </div>
                    ${isActive ? `
                        <div style="display:flex;gap:6px">
                            <button class="btn-sm btn-edit" data-url="${esc(linkUrl)}" onclick="copyShareUrl(this.dataset.url, this)">📋</button>
                            <button class="btn-sm btn-delete" onclick="revokeLink('${l.token}')">Revoke</button>
                        </div>
                    ` : ''}
                </div>`;
        }).join('');
    } catch (e) {
        /* Offline */
    }
}

async function revokeLink(token) {
    const { url, admin } = getSettings();
    if (!confirm('Revoke this link? Staff using it will lose access.')) return;

    try {
        let res = await fetch(`${url}/api/share-links/${token}`, {
            method: 'DELETE',
            headers: { 'x-admin-key': admin },
        });

        if (res.status === 404) {
            res = await fetch(`${url}/api/share/${token}`, {
                method: 'DELETE',
                headers: { 'x-admin-key': admin },
            });
        }

        if (res.ok) loadShareLinks();
    } catch (e) {
        alert('Could not revoke link — check connection.');
    }
}

// ── Clipboard & Native Share ──
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

// ── Utility Formatting ──
function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function num(n) {
    return n == null
        ? '—'
        : Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2 });
}

// ── STARTUP ──
// Auto-import token or backend URL if opened via a share link
const urlParams = new URLSearchParams(window.location.search);
const sharedToken = urlParams.get('token');
const sharedUrl = urlParams.get('url');
if (sharedToken) localStorage.setItem('bk_token', sharedToken.trim());
if (sharedUrl) localStorage.setItem('bk_url', sharedUrl.trim().replace(/\/+$/, ''));

// Initialize views
showOwnerTabs();
onSearch('');
syncNow();
setInterval(syncNow, 60_000);

// Register service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
}
