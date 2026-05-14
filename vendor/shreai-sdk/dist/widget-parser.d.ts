export interface TodoItem {
    id: string;
    text: string;
    done: boolean;
}
export interface TodoBlock {
    type: 'todo';
    title?: string;
    items: TodoItem[];
    editable?: boolean;
}
export interface TableBlock {
    type: 'table';
    title?: string;
    headers: string[];
    rows: string[][];
    sortable?: boolean;
}
export interface ChartBlock {
    type: 'chart';
    chartType: 'bar' | 'line' | 'pie' | 'area';
    title?: string;
    labels: string[];
    datasets: Array<{
        label: string;
        data: number[];
        color?: string;
    }>;
    options?: {
        showValues?: boolean;
        currency?: boolean;
        stacked?: boolean;
    };
}
export interface IframeBlock {
    type: 'iframe';
    title?: string;
    src: string;
    height?: number;
}
export interface LinkCardBlock {
    type: 'link-card';
    title: string;
    url: string;
    description?: string;
    image?: string;
    favicon?: string;
}
export interface ImageGalleryBlock {
    type: 'image-gallery';
    title?: string;
    images: Array<{
        src: string;
        alt?: string;
        caption?: string;
    }>;
}
export interface DataGridBlock {
    type: 'data-grid';
    title?: string;
    columns: Array<{
        key: string;
        label: string;
        width?: number;
        align?: 'left' | 'center' | 'right';
    }>;
    rows: Record<string, unknown>[];
}
export interface WeatherBlock {
    type: 'weather';
    location: string;
    current: {
        temp: number;
        condition: string;
        icon?: string;
    };
    forecast?: Array<{
        day: string;
        high: number;
        low: number;
        condition: string;
    }>;
}
export interface MetricBlock {
    type: 'metric';
    title?: string;
    value: string | number;
    unit?: string;
    change?: number;
    changeLabel?: string;
    icon?: string;
}
export type ContentBlock = TodoBlock | TableBlock | ChartBlock | IframeBlock | LinkCardBlock | ImageGalleryBlock | DataGridBlock | WeatherBlock | MetricBlock;
export interface ParseResult {
    text: string;
    blocks: ContentBlock[];
}
export declare function extractBlocks(markdown: string): ParseResult;
export declare function hasBlocks(markdown: string): boolean;
export declare function serializeBlock(block: ContentBlock): string;
