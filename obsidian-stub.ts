// 仅用于在 node 里跑自测：替代 obsidian 运行时
export class ItemView {
	getViewType(): string {
		return "";
	}
	containerEl: any = { contains: () => false, isConnected: true };
}
export class Plugin {}
export class Notice {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class Editor {}
export class MarkdownView {}
