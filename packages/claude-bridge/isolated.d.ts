import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ClaudeBridgeExtensionOptions {
	userDir?: string;
	/** Claude child/profile environment overrides. Undefined values suppress inherited keys. */
	env?: NodeJS.ProcessEnv;
}

export declare function createClaudeBridgeExtension(options?: ClaudeBridgeExtensionOptions): (pi: ExtensionAPI) => void;
declare const extension: (pi: ExtensionAPI) => void;
export default extension;
