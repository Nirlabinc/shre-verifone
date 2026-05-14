const INJECTION_PATTERNS = [
    {
        pattern: /\bsystem\s*(?:prompt|instruction|message)\s*[:=]/gi,
        replacement: '[filtered:system-override]',
        label: 'system-override',
    },
    {
        pattern: /\byou\s+are\s+(?:now|a)\b/gi,
        replacement: '[filtered:role-hijack]',
        label: 'role-hijack',
    },
    {
        pattern: /\bignore\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|prompts?|rules?)/gi,
        replacement: '[filtered:ignore-instructions]',
        label: 'ignore-instructions',
    },
    {
        pattern: /\bforget\s+(?:all\s+)?(?:previous|above|prior|your)\s+(?:instructions?|prompts?|rules?|context)/gi,
        replacement: '[filtered:forget-instructions]',
        label: 'forget-instructions',
    },
    {
        pattern: /\bdisregard\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|prompts?|rules?)/gi,
        replacement: '[filtered:disregard]',
        label: 'disregard',
    },
    {
        pattern: /\boverride\s+(?:system|safety|security)\b/gi,
        replacement: '[filtered:override]',
        label: 'override',
    },
    {
        pattern: /<\/?(?:system|assistant|user|human|tool_result|function_call|tool_use)>/gi,
        replacement: '[filtered:delimiter]',
        label: 'delimiter-injection',
    },
    {
        pattern: /\bfetch\s*\(\s*['"`]https?:\/\//gi,
        replacement: '[filtered:exfil-fetch]',
        label: 'exfil-fetch',
    },
    {
        pattern: /\bnew\s+Image\s*\(\s*\)\s*\.src\s*=/gi,
        replacement: '[filtered:exfil-image]',
        label: 'exfil-image',
    },
    {
        pattern: /\bDAN\s+(?:mode|prompt)/gi,
        replacement: '[filtered:jailbreak]',
        label: 'jailbreak-DAN',
    },
    {
        pattern: /\bdeveloper\s+mode\s+(?:enabled|on|activated)/gi,
        replacement: '[filtered:jailbreak]',
        label: 'jailbreak-devmode',
    },
];
function stripDangerousHtml(html) {
    return (html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
        .replace(/<(?:object|embed|applet)\b[^>]*>[\s\S]*?<\/(?:object|embed|applet)>/gi, '')
        .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
        .replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '')
        .replace(/\bhref\s*=\s*["']javascript:[^"']*["']/gi, 'href="[filtered]"')
        .replace(/\bsrc\s*=\s*["']javascript:[^"']*["']/gi, 'src="[filtered]"')
        .replace(/\bsrc\s*=\s*["']data:[^"']*["']/gi, 'src="[filtered:data-uri]"'));
}
function stripControlChars(text) {
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
export function sanitizeForLLM(content, opts = {}) {
    const { stripHtml = true, maxLength = 8000 } = opts;
    const filtersApplied = [];
    let result = content;
    const beforeControl = result;
    result = stripControlChars(result);
    if (result !== beforeControl)
        filtersApplied.push('control-chars');
    if (stripHtml) {
        const beforeHtml = result;
        result = stripDangerousHtml(result);
        if (result !== beforeHtml)
            filtersApplied.push('dangerous-html');
    }
    for (const { pattern, replacement, label } of INJECTION_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(result)) {
            pattern.lastIndex = 0;
            result = result.replace(pattern, replacement);
            filtersApplied.push(label);
        }
    }
    if (result.length > maxLength) {
        result = result.slice(0, maxLength) + '\n... (truncated)';
        filtersApplied.push('truncated');
    }
    return {
        content: result.trim(),
        filtered: filtersApplied.length > 0,
        filtersApplied,
    };
}
export function sanitizeForRAG(content, maxLength = 2000) {
    const result = sanitizeForLLM(content, { stripHtml: true, maxLength });
    const cleaned = result.content
        .replace(/\n{4,}/g, '\n\n\n')
        .replace(/[ \t]{4,}/g, '  ')
        .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '')
        .trim();
    const ragFilters = [...result.filtersApplied];
    if (cleaned !== result.content)
        ragFilters.push('rag-normalize');
    return {
        content: cleaned,
        filtered: ragFilters.length > 0,
        filtersApplied: ragFilters,
    };
}
