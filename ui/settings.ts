import {App, Plugin, PluginSettingTab, Setting} from 'obsidian';
import {DropboxAuth} from 'dropbox';
import {CLIENT_ID, OAUTH_CODE} from 'consts';

export interface DropboxSyncSettingsI {
	vaultPath: string,
	refreshToken?: string;
	accessToken?: string;
	tokenExpiresAt: number;
    lastSync?: number;
}

export const DEFAULT_SETTINGS: DropboxSyncSettingsI = {
	vaultPath: '',
	tokenExpiresAt: 0,
};

export interface DropboxSyncPluginI extends Plugin {
    codeVerifier: string;
	settings: DropboxSyncSettingsI;
    saveSettings(): Promise<void>;
}

export class DropboxSyncSettingsTab extends PluginSettingTab {
	plugin: DropboxSyncPluginI;

	constructor(app: App, plugin: DropboxSyncPluginI) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName('Sign In to Dropbox')
			.setDesc('Click the button to start OAuth flow')
			.addButton(button => button
				.setButtonText('Sign In')
				.onClick(async () => {
					let dbxAuth = new DropboxAuth({clientId: CLIENT_ID});
					let url = await dbxAuth.getAuthenticationUrl(
						`obsidian://${OAUTH_CODE}`, undefined, 'code',
						'offline',
						['account_info.read', 'files.metadata.write',
							'files.metadata.read', 'files.content.write',
							'files.content.read'],
						'none', true);
					this.plugin.codeVerifier = dbxAuth.getCodeVerifier();
					window.open(''+url);
				}));
		let vaultPath = '';
		new Setting(containerEl)
			.setName('Vault Path')
			.setDesc('The path in Dropbox to sync to')
			.addText(text => text
				.setPlaceholder('/path/to/vault')
				.setValue(this.plugin.settings.vaultPath)
				.onChange(async (value) => {
					vaultPath = value;
				}))
			.addExtraButton(button => button
				.setIcon('save')
				.setTooltip('Save')
				.onClick(async () => {
					this.plugin.settings.vaultPath = vaultPath;
					await this.plugin.saveSettings();
				}));
	}
}