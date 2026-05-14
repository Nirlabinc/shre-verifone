import { createCortexClient } from './cortex.js';
import { createLogger } from './logger.js';
const CORE_IP = ['shre', 'main'];
export function createMarketplaceClient(config) {
    const log = createLogger('marketplace-client');
    const cortex = createCortexClient('marketplace-client', { url: config?.cortexUrl });
    function isCoreIP(agentId) {
        return CORE_IP.includes(agentId);
    }
    async function registerAgent(agent) {
        if (isCoreIP(agent.id)) {
            throw new Error(`Cannot register core IP agent: ${agent.id}. Shre and Ellie are never sold.`);
        }
        const record = {
            ...agent,
            metrics: { tasksCompleted: 0, avgQuality: 0, avgResponseMs: 0, activeInstances: 0 },
            publishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await cortex.write('marketplace_agent', record);
        log.info('Agent registered in marketplace', { agentId: agent.id, category: agent.category });
    }
    async function registerSkill(skill) {
        await cortex.write('marketplace_skill', skill);
        log.info('Skill registered in marketplace', { skillId: skill.id });
    }
    async function deployAgent(request) {
        if (isCoreIP(request.agentId)) {
            throw new Error(`Cannot deploy core IP agent: ${request.agentId}`);
        }
        await cortex.write('marketplace_deployment', {
            agent_id: request.agentId,
            workspace: request.targetWorkspace,
            tenant: request.targetTenant,
            skills: request.skills,
            deployed_at: new Date().toISOString(),
            feedback_wired: true,
            mib_reporting: true,
        });
        log.info('Agent deployed', {
            agentId: request.agentId,
            workspace: request.targetWorkspace,
            skills: request.skills.length,
        });
        return {
            success: true,
            instanceId: `${request.agentId}-${request.targetWorkspace}-${Date.now()}`,
            workspace: request.targetWorkspace,
            agent: request.agentId,
            skills: request.skills,
            feedbackWired: true,
            mibReporting: true,
        };
    }
    async function reportUsage(agentId, usage) {
        await cortex.write('marketplace_usage', {
            agent_id: agentId,
            ...usage,
            recorded_at: new Date().toISOString(),
        });
    }
    async function getCatalog() {
        try {
            const agents = await cortex.query('marketplace_agent', { status: 'available' });
            const skills = await cortex.query('marketplace_skill');
            return {
                agents: (agents?.data || []),
                skills: (skills?.data || []),
            };
        }
        catch (err) {
            log.debug('[marketplace] Failed to list catalog from CortexDB', {
                error: err.message,
            });
            return { agents: [], skills: [] };
        }
    }
    return {
        isCoreIP,
        registerAgent,
        registerSkill,
        deployAgent,
        reportUsage,
        getCatalog,
        CORE_IP,
    };
}
