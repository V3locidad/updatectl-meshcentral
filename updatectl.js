/*
 * updatectl — MeshCentral plugin to inventory + install Windows Updates.
 *
 * Pas de dépendance externe : on passe par le COM Microsoft.Update.Session
 * dans un script PowerShell exécuté côté agent (SYSTEM). L'agent renvoie
 * inventaire ou résultat d'install via le canal plugin.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const inventoryWaiters = {};  // dispatchId -> { res, expires, nodeId }
const installWaiters = {};    // dispatchId -> { res, expires }
const inventoryCache = {};    // nodeId -> { ts, data }
const inventoryInflight = {}; // nodeId -> Promise pour dédupliquer les requêtes simultanées
const INVENTORY_TTL_MS = 10 * 60 * 1000;

function sendJson(res, code, obj) {
    try { res.status(code).set('Content-Type', 'application/json').end(JSON.stringify(obj)); }
    catch (e) {}
}

module.exports.updatectl = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = [];

    obj.serveraction = function (command) {
        try {
            if (!command || !command.pluginaction) return;
            if (command.pluginaction === 'inventoryResult') {
                const w = inventoryWaiters[command.dispatchId];
                if (!w) return;
                delete inventoryWaiters[command.dispatchId];
                const payload = {
                    ok: !command.error,
                    error: command.error,
                    winver: command.winver || '',
                    displayVersion: command.displayVersion || '',
                    ubr: command.ubr || '',
                    lastInstall: command.lastInstall || '',
                    rebootPending: !!command.rebootPending,
                    updates: command.updates || [],
                    source: command.source || 'default',
                    fallbackError: command.fallbackError || null,
                    raw: command.raw || '',
                };
                // Cache si succès — clé = nodeId mémorisé dans le waiter
                if (w.nodeId && payload.ok) {
                    inventoryCache[w.nodeId] = { ts: Date.now(), data: payload };
                }
                if (w.nodeId) delete inventoryInflight[w.nodeId];
                // Réponse à TOUS les waiters (Array) accumulés pour ce nodeId
                const ress = Array.isArray(w.res) ? w.res : [w.res];
                ress.forEach((r) => { try { sendJson(r, 200, Object.assign({ cached: false }, payload)); } catch (_) {} });
                return;
            }
            if (command.pluginaction === 'installResult') {
                const w2 = installWaiters[command.dispatchId];
                if (!w2) return;
                delete installWaiters[command.dispatchId];
                try { sendJson(w2.res, 200, {
                    ok: !command.error,
                    error: command.error,
                    installed: command.installed || [],
                    failed: command.failed || [],
                    rebootRequired: !!command.rebootRequired,
                    source: command.source || 'default',
                    raw: command.raw || '',
                }); } catch (e) {}
                return;
            }
        } catch (e) { console.log('updatectl serveraction: ' + e.message); }
    };

    obj.handleAdminReq = function (req, res, user) {
        const action = String((req.query && req.query.action) || '');
        if (!action) return res.render(path.join(__dirname, 'views/updatectl'), { user: user });

        if (action === 'ping') return sendJson(res, 200, { ok: true, plugin: 'updatectl' });

        if (action === 'agents') {
            const db = obj.meshServer.db;
            const wsagents = (obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            db.GetAllType('mesh', (e1, meshDocs) => {
                if (e1) return sendJson(res, 500, { error: e1.message });
                const meshById = {};
                (meshDocs || []).forEach((m) => { if (m && m._id) meshById[m._id] = m.name; });
                db.GetAllType('node', (e2, nodes) => {
                    if (e2) return sendJson(res, 500, { error: e2.message });
                    // Filtre Windows : agent.id 4 (Windows x64), 3 (x86), 5 (ARM64), etc.
                    // On garde tout ce qui a osdesc commençant par "Windows" ou un agent id Windows.
                    const list = (nodes || [])
                        .filter((n) => {
                            const os = (n.osdesc || '').toLowerCase();
                            if (os.indexOf('windows') !== -1) return true;
                            const aid = n.agent && n.agent.id;
                            return aid === 3 || aid === 4 || aid === 5 || aid === 10 || aid === 11;
                        })
                        .map((n) => ({
                            id: n._id,
                            name: n.name || '?',
                            mesh: meshById[n.meshid] || '?',
                            meshid: n.meshid,
                            os: n.osdesc || '',
                            online: !!wsagents[n._id],
                        }))
                        .sort((a, b) => {
                            if (a.online !== b.online) return a.online ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        });
                    sendJson(res, 200, { agents: list });
                });
            });
            return;
        }

        if (action === 'inventory') {
            const nodeId = String(req.query.nodeId || '');
            const refresh = req.query.refresh === '1';
            const bypassWsus = req.query.bypassWsus === '1';
            // Cache hit
            if (!refresh && inventoryCache[nodeId] && (Date.now() - inventoryCache[nodeId].ts) < INVENTORY_TTL_MS) {
                return sendJson(res, 200, Object.assign({ cached: true, age: Date.now() - inventoryCache[nodeId].ts }, inventoryCache[nodeId].data));
            }
            // Inflight : on attache notre res à la requête en cours pour ce nodeId
            if (inventoryInflight[nodeId]) {
                const w = inventoryWaiters[inventoryInflight[nodeId]];
                if (w) {
                    if (!Array.isArray(w.res)) w.res = [w.res];
                    w.res.push(res);
                    return;
                }
                delete inventoryInflight[nodeId];
            }
            const wsagents = (obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const target = wsagents[nodeId];
            if (!target || typeof target.send !== 'function') return sendJson(res, 200, { ok: false, error: 'agent déconnecté' });
            const dispatchId = 'inv-' + crypto.randomBytes(8).toString('hex');
            inventoryWaiters[dispatchId] = { res: [res], expires: Date.now() + 300000, nodeId: nodeId };
            inventoryInflight[nodeId] = dispatchId;
            setTimeout(() => {
                const w = inventoryWaiters[dispatchId];
                if (!w) return;
                delete inventoryWaiters[dispatchId];
                delete inventoryInflight[nodeId];
                const ress = Array.isArray(w.res) ? w.res : [w.res];
                ress.forEach((r) => { try { sendJson(r, 200, { ok: false, error: 'timeout agent (5 min)' }); } catch (_) {} });
            }, 300000);
            try {
                target.send(JSON.stringify({
                    action: 'plugin', plugin: 'updatectl', pluginaction: 'inventory',
                    dispatchId: dispatchId,
                    bypassWsus: bypassWsus,
                }));
            } catch (e) {
                delete inventoryWaiters[dispatchId];
                delete inventoryInflight[nodeId];
                return sendJson(res, 200, { ok: false, error: e.message });
            }
            return;
        }

        // Liste les nodes ayant un inventaire en cache (frais).
        if (action === 'cacheStatus') {
            const now = Date.now();
            const out = {};
            Object.keys(inventoryCache).forEach((nid) => {
                const c = inventoryCache[nid];
                if (now - c.ts < INVENTORY_TTL_MS) {
                    out[nid] = { age: now - c.ts, updates: (c.data.updates || []).length, rebootPending: !!c.data.rebootPending };
                }
            });
            // Inflight aussi : utile pour l'UI (badge "en cours")
            const inflight = Object.keys(inventoryInflight);
            return sendJson(res, 200, { cache: out, inflight: inflight, ttlMs: INVENTORY_TTL_MS });
        }

        if (action === 'install') {
            const payload = (req.query && req.query.payload) ? JSON.parse(decodeURIComponent(req.query.payload)) : {};
            const nodeId = String(payload.nodeId || '');
            const updateIds = Array.isArray(payload.updateIds) ? payload.updateIds : [];
            const installAll = !!payload.all;
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            if (!installAll && !updateIds.length) return sendJson(res, 400, { error: 'updateIds requis (ou all=true)' });
            const wsagents = (obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const target = wsagents[nodeId];
            if (!target || typeof target.send !== 'function') return sendJson(res, 200, { ok: false, error: 'agent déconnecté' });
            const dispatchId = 'ins-' + crypto.randomBytes(8).toString('hex');
            installWaiters[dispatchId] = { res: res, expires: Date.now() + 3600000 };
            setTimeout(() => {
                const w = installWaiters[dispatchId];
                if (!w) return;
                delete installWaiters[dispatchId];
                try { sendJson(w.res, 200, { ok: false, error: 'timeout agent (60 min)' }); } catch (_) {}
            }, 3600000);
            try {
                target.send(JSON.stringify({
                    action: 'plugin', plugin: 'updatectl', pluginaction: 'install',
                    dispatchId: dispatchId,
                    updateIds: updateIds, all: installAll,
                    bypassWsus: !!payload.bypassWsus,
                }));
            } catch (e) {
                delete installWaiters[dispatchId];
                return sendJson(res, 200, { ok: false, error: e.message });
            }
            return;
        }

        return sendJson(res, 404, { error: 'action inconnue: ' + action });
    };

    return obj;
};
