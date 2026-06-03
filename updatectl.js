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

const inventoryWaiters = {};  // dispatchId -> { res, expires }
const installWaiters = {};    // dispatchId -> { res, expires }

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
                try { sendJson(w.res, 200, {
                    ok: !command.error,
                    error: command.error,
                    winver: command.winver || '',
                    displayVersion: command.displayVersion || '',
                    ubr: command.ubr || '',
                    lastInstall: command.lastInstall || '',
                    rebootPending: !!command.rebootPending,
                    updates: command.updates || [],
                    raw: command.raw || '',
                }); } catch (e) {}
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
            const wsagents = (obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const target = wsagents[nodeId];
            if (!target || typeof target.send !== 'function') return sendJson(res, 200, { ok: false, error: 'agent déconnecté' });
            const dispatchId = 'inv-' + crypto.randomBytes(8).toString('hex');
            inventoryWaiters[dispatchId] = { res: res, expires: Date.now() + 300000 };
            setTimeout(() => {
                const w = inventoryWaiters[dispatchId];
                if (!w) return;
                delete inventoryWaiters[dispatchId];
                try { sendJson(w.res, 200, { ok: false, error: 'timeout agent (5 min)' }); } catch (_) {}
            }, 300000);
            try {
                target.send(JSON.stringify({ action: 'plugin', plugin: 'updatectl', pluginaction: 'inventory', dispatchId: dispatchId }));
            } catch (e) {
                delete inventoryWaiters[dispatchId];
                return sendJson(res, 200, { ok: false, error: e.message });
            }
            return;
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
