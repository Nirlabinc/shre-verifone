const WIDGET_FENCE_RE = /```mib-widget\s*\n([\s\S]*?)```/g;
const VALID_TYPES = new Set([
    'todo',
    'table',
    'chart',
    'iframe',
    'link-card',
    'image-gallery',
    'data-grid',
    'weather',
    'metric',
]);
export function extractBlocks(markdown) {
    const blocks = [];
    const text = markdown.replace(WIDGET_FENCE_RE, (_match, json) => {
        try {
            const parsed = JSON.parse(json.trim());
            if (parsed &&
                typeof parsed === 'object' &&
                typeof parsed.type === 'string' &&
                VALID_TYPES.has(parsed.type)) {
                blocks.push(parsed);
            }
            else {
                return _match;
            }
        }
        catch (err) {
            return _match;
        }
        return '';
    });
    return { text: text.trim(), blocks };
}
export function hasBlocks(markdown) {
    return WIDGET_FENCE_RE.test(markdown);
}
export function serializeBlock(block) {
    return '```mib-widget\n' + JSON.stringify(block, null, 2) + '\n```';
}
