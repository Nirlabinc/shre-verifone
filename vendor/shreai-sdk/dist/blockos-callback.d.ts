export interface BlockOSUser {
    id: string;
    email: string;
    name?: string;
    role?: string;
    activeWorkspaceId?: string;
}
export interface BlockOSCallbackConfig {
    authUrl?: string;
    onUser: (user: BlockOSUser) => Promise<{
        redirectTo: string;
    }>;
    onError?: (error: string, status: number) => void;
}
export type ValidateSuccess = {
    ok: true;
    user: BlockOSUser;
};
export type ValidateFailure = {
    ok: false;
    error: string;
    status: number;
};
export type ValidateResult = ValidateSuccess | ValidateFailure;
export declare function validateBlockOSToken(token: string, authUrl?: string): Promise<ValidateResult>;
export declare function createBlockOSCallbackHandler(config: BlockOSCallbackConfig): (c: {
    req: {
        query: (k: string) => string | undefined;
    };
    json: (d: unknown, s?: number) => Response;
    redirect: (u: string) => Response;
}) => Promise<Response>;
export declare function createBlockOSCallbackMiddleware(config: BlockOSCallbackConfig): (req: {
    query: Record<string, string | undefined>;
}, res: {
    status: (s: number) => {
        json: (d: unknown) => void;
    };
    redirect: (u: string) => void;
}) => Promise<void>;
