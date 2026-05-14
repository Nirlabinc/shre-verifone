export interface SanitizeResult {
    content: string;
    filtered: boolean;
    filtersApplied: string[];
}
export declare function sanitizeForLLM(content: string, opts?: {
    stripHtml?: boolean;
    maxLength?: number;
    source?: string;
}): SanitizeResult;
export declare function sanitizeForRAG(content: string, maxLength?: number): SanitizeResult;
