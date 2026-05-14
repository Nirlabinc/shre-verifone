import { createLogger } from './logger.js';
const log = createLogger('shre-sdk:tool-permissions');
export function createToolPermissions(options = {}) {
    let Database;
    try {
        Database = require('better-sqlite3');
    }
    catch (err) {
        throw new Error('better-sqlite3 is required for tool-permissions. Install it: npm i better-sqlite3');
    }
    const { mkdirSync } = require('node:fs');
    const { join } = require('node:path');
    const { homedir } = require('node:os');
    const dbDir = options.dbPath
        ? require('node:path').dirname(options.dbPath)
        : join(homedir(), '.shre', 'router');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = options.dbPath ?? join(dbDir, 'tool-permissions.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
    CREATE TABLE IF NOT EXISTS tool_grants (
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      granted_by TEXT DEFAULT 'system',
      PRIMARY KEY (agent_id, tool_name)
    );
  `);
    if (options.bootstrap) {
        const shreGrant = db
            .prepare("SELECT 1 FROM tool_grants WHERE agent_id = 'shre' AND tool_name = '*'")
            .get();
        if (!shreGrant) {
            db.prepare("INSERT OR IGNORE INTO tool_grants (agent_id, tool_name, granted_by) VALUES ('shre', '*', 'bootstrap')").run();
            log.info('[permissions] Bootstrapped shre agent with full tool access');
        }
        for (const storeAgent of ['rapidrms-support', 'rapidrms-admin', 'storepulse']) {
            const existing = db
                .prepare("SELECT 1 FROM tool_grants WHERE agent_id = ? AND tool_name = 'web_fetch'")
                .get(storeAgent);
            if (!existing) {
                db.prepare("INSERT OR IGNORE INTO tool_grants (agent_id, tool_name, granted_by) VALUES (?, 'web_fetch', 'bootstrap')").run(storeAgent);
                log.info('[permissions] Bootstrapped web_fetch for store agent', { agent: storeAgent });
            }
        }
    }
    const stmtGetGrants = db.prepare('SELECT tool_name FROM tool_grants WHERE agent_id = ?');
    const stmtAddGrant = db.prepare('INSERT OR IGNORE INTO tool_grants (agent_id, tool_name, granted_by) VALUES (?, ?, ?)');
    const stmtRemoveGrant = db.prepare('DELETE FROM tool_grants WHERE agent_id = ? AND tool_name = ?');
    const stmtRemoveAll = db.prepare('DELETE FROM tool_grants WHERE agent_id = ?');
    const stmtListAll = db.prepare('SELECT agent_id, tool_name, granted_at, granted_by FROM tool_grants ORDER BY agent_id, tool_name');
    return {
        getAgentTools(agentId) {
            const rows = stmtGetGrants.all(agentId);
            return rows.map((r) => r.tool_name);
        },
        canUseTool(agentId, toolName) {
            const grants = this.getAgentTools(agentId);
            if (grants.length === 0)
                return false;
            if (grants.includes('*'))
                return true;
            return grants.includes(toolName);
        },
        filterToolsForAgent(agentId, allTools) {
            const grants = this.getAgentTools(agentId);
            if (grants.length === 0)
                return [];
            if (grants.includes('*'))
                return allTools;
            return allTools.filter((t) => grants.includes(t.name));
        },
        grantTool(agentId, toolName, grantedBy = 'api') {
            stmtAddGrant.run(agentId, toolName, grantedBy);
            log.info('[permissions] Granted', { agentId, toolName, grantedBy });
        },
        revokeTool(agentId, toolName) {
            stmtRemoveGrant.run(agentId, toolName);
            log.info('[permissions] Revoked', { agentId, toolName });
        },
        setAgentTools(agentId, tools, grantedBy = 'api') {
            const tx = db.transaction(() => {
                stmtRemoveAll.run(agentId);
                for (const tool of tools) {
                    stmtAddGrant.run(agentId, tool, grantedBy);
                }
            });
            tx();
            log.info('[permissions] Set tools', { agentId, tools, grantedBy });
        },
        listAllGrants() {
            const rows = stmtListAll.all();
            return rows.map((r) => ({
                agentId: r.agent_id,
                toolName: r.tool_name,
                grantedAt: r.granted_at,
                grantedBy: r.granted_by,
            }));
        },
        getGrantsSummary() {
            const all = this.listAllGrants();
            const summary = {};
            for (const g of all) {
                if (!summary[g.agentId])
                    summary[g.agentId] = [];
                summary[g.agentId].push(g.toolName);
            }
            return summary;
        },
    };
}
