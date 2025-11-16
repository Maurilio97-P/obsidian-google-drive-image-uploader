import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

/** ---------------- Settings ---------------- */
interface DriveUploaderSettings {
  googleClientId: string;       // OAuth desktop client ID (required)
  googleClientSecret: string;   // optional for device flow; keep empty if you didn't get one
  googleApiKey: string;         // for alt=media fallback (recommended)
  driveFolderId: string;        // optional: uploads target folder
  makePublic: boolean;          // set "anyone with link → reader"
  useOriginalName: boolean;     // keep original file name if available
  filenamePrefix: string;       // used if not using original name
  fallbackToLocal: boolean;     // save locally if cloud embed fails
  localFolder: string;          // local fallback folder under vault
  accessToken?: string;         // OAuth tokens (persisted)
  refreshToken?: string;
  tokenExpiresAt?: number;      // epoch ms
}

const DEFAULT_SETTINGS: DriveUploaderSettings = {
  googleClientId: "",
  googleClientSecret: "",
  googleApiKey: "",
  driveFolderId: "",
  makePublic: true,
  useOriginalName: false,
  filenamePrefix: "img_",
  fallbackToLocal: true,
  localFolder: "DriveUploads",
};

/** ---------------- Small helpers ---------------- */
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function hasSession(s: DriveUploaderSettings): boolean {
  return !!(s.refreshToken && s.googleClientId);
}

function tokenValid(s: DriveUploaderSettings): boolean {
  return !!(s.accessToken && s.tokenExpiresAt && Date.now() < s.tokenExpiresAt - 30000);
}

async function postJSON(url: string, body: any, headers: Record<string,string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function postMultipart(url: string, body: Blob | FormData, headers: Record<string,string>) {
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** ---------------- Device Flow Modal ---------------- */
class DeviceFlowModal extends Modal {
  private code: string;
  private url: string;
  private statusEl!: HTMLDivElement;

  constructor(app: App, code: string, url: string) {
    super(app);
    this.code = code;
    this.url = url;
    this.setTitle("Google Sign-in (Device Flow)");
  }

  onOpen() {
    const { contentEl } = this;

    const p = contentEl.createEl("p");
    p.setText("To connect this plugin, open the verification page and paste this code:");

    const codeBox = contentEl.createEl("div", { cls: "device-code-box" });
    codeBox.setText(this.code);
    codeBox.setAttr("style", "font-size:20px;font-weight:700;letter-spacing:2px;padding:6px 10px;border:1px solid var(--background-modifier-border);border-radius:8px;width:max-content;cursor:pointer;");
    codeBox.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.code);
        new Notice("Code copied");
      } catch {}
    });

    const btnRow = contentEl.createEl("div", { cls: "device-btn-row" });
    btnRow.setAttr("style", "display:flex;gap:8px;margin-top:10px;");

    const openBtn = btnRow.createEl("button", { text: "Open verification page" });
    openBtn.onclick = () => {
      try { window.open(this.url, "_blank"); } catch {}
    };

    const copyCodeBtn = btnRow.createEl("button", { text: "Copy code" });
    copyCodeBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(this.code); new Notice("Code copied"); } catch {}
    };

    const copyBothBtn = btnRow.createEl("button", { text: "Copy link + code" });
    copyBothBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(`${this.url}\n${this.code}`); new Notice("Link + code copied"); } catch {}
    };

    this.statusEl = contentEl.createDiv({ text: "Waiting for approval…", cls: "device-status" });
    this.statusEl.setAttr("style", "margin-top:12px;opacity:0.8;");
  }

  setStatus(txt: string) {
    if (this.statusEl) this.statusEl.setText(txt);
  }
}


/** ---------------- Plugin ---------------- */
export default class DriveImageUploader extends Plugin {
  settings: DriveUploaderSettings;
  public settingsTab!: DriveUploaderSettingsTab;
  private statusBarItem?: HTMLElement;
  private activeUploads = 0;

  async onload() {
    await this.loadSettings();
    this.settingsTab = new DriveUploaderSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar("checking");

    // Check connection status on startup
    if (hasSession(this.settings)) {
      try {
        if (!tokenValid(this.settings)) {
          await this.ensureAccessToken(); // Refresh token silently
        }
        new Notice("Drive Image Uploader: connected ✅", 3000);
        this.updateStatusBar("ready");
      } catch (e) {
        new Notice("Drive Image Uploader: not connected - connect in Settings", 5000);
        this.updateStatusBar("not connected - connect in Settings");
      }
    } else {
      new Notice("Drive Image Uploader loaded. Connect in Settings.", 3000);
      this.updateStatusBar("not connected - connect in Settings");
    }

    // Command to connect OAuth (device flow)
    this.addCommand({
      id: "connect-google-drive",
      name: "Connect Google Drive (Device Flow)",
      callback: () => this.beginDeviceFlow()
    });

    // Command to check connection status
    this.addCommand({
      id: "check-drive-connection",
      name: "Check Google Drive connection",
      callback: async () => {
        try {
          await this.ensureAccessToken();
          this.updateStatusBar("ready");
          new Notice("Drive: connected ✅");
        } catch (e) {
          this.updateStatusBar("not connected - connect in Settings");
          new Notice("Drive: not connected - connect in Settings", 4000);
        }
      }
    });

    // Intercept paste
    this.registerEvent(
      this.app.workspace.on("editor-paste", async (evt: ClipboardEvent, editor: Editor) => {
        try {
          if (!evt.clipboardData) return;
          const files = Array.from(evt.clipboardData.files || []);
          const image = files.find(f => f.type.startsWith("image/"));
          if (!image) return;

          evt.preventDefault();
          await this.withInlineUploadingMarker(editor, image, async () => {
            return await this.handleOneImage(image);
          });
        } catch (e) {
          console.error(e);
          new Notice("Drive upload error (see console)");
        }
      })
    );

    // Intercept drag & drop
    this.registerEvent(
      this.app.workspace.on("editor-drop", async (evt: DragEvent, editor: Editor) => {
        try {
          if (!evt.dataTransfer) return;
          const images = Array.from(evt.dataTransfer.files || []).filter(f => f.type.startsWith("image/"));
          if (!images.length) return;

          evt.preventDefault();
          // Process images one by one so markers replace correctly
          for (const img of images) {
            await this.withInlineUploadingMarker(editor, img, async () => {
              return await this.handleOneImage(img);
            });
          }
        } catch (e) {
          console.error(e);
          new Notice("Drive upload error (see console)");
        }
      })
    );
  }

  private updateStatusBar(state: "ready" | "uploading" | "connected" | "not connected" | "checking") {
    if (!this.statusBarItem) return;
    if (state === "uploading" && this.activeUploads > 0) {
      this.statusBarItem.setText(`Drive: uploading ${this.activeUploads}…`);
    } else if (state === "ready") {
      this.statusBarItem.setText("Drive: ready");
    } else {
      this.statusBarItem.setText(`Drive: ${state}`);
    }
  }

  private async withInlineUploadingMarker(editor: Editor, file: File, doWork: () => Promise<string | null>) {
    const filename = file.name || "image";
    const marker = `![Uploading ${filename}…]()`;
    const from = editor.getCursor();
    editor.replaceSelection(marker);
    const to = editor.getCursor();

    this.activeUploads++;
    this.updateStatusBar("uploading");

    try {
      const md = await doWork();
      editor.replaceRange(md ?? "**Upload failed**", from, to);
    } catch (e) {
      console.error(e);
      editor.replaceRange("**Upload failed**", from, to);
    } finally {
      this.activeUploads--;
      this.updateStatusBar(this.activeUploads > 0 ? "uploading" : "ready");
    }
  }

  async handleOneImage(file: File): Promise<string | null> {
    // 1) Try Drive upload
    try {
      const fileId = await this.uploadToDrive(file);

      // 2) Primary embed (lh3)
      const lh3 = `https://lh3.googleusercontent.com/d/${fileId}`;
      // We can't preflight-fetch reliably due to CORS; embed directly:
      // If user's Obsidian can render lh3 (you tested), this is enough.
      return `![](${lh3})`;
    } catch (e) {
      console.warn("Drive upload failed, will try fallback:", e);
    }

    // 3) Fallback: alt=media (needs API key)
    if (this.settings.googleApiKey) {
      const altMedia = (id: string) =>
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(this.settings.googleApiKey)}`;
      try {
        // try to upload again (in case only link step failed)
        const id = await this.uploadToDrive(file);
        return `![](${altMedia(id)})`;
      } catch (e) {
        console.warn("Alt=media fallback failed:", e);
      }
    }

    // 4) Final fallback: local save
    if (this.settings.fallbackToLocal) {
      const local = await this.saveLocal(file);
      return `![](${local})`;
    }

    new Notice("All upload fallbacks failed.");
    return null;
  }

  /** ---------------- Google OAuth (Device Flow) ---------------- */
  async beginDeviceFlow() {
  if (!this.settings.googleClientId) {
    new Notice("Set Google Client ID in settings.");
    return;
  }
  try {
    const scope = "https://www.googleapis.com/auth/drive.file";
    const device = await postJSON("https://oauth2.googleapis.com/device/code", {
      client_id: this.settings.googleClientId,
      scope
    });

    // Friendly UI: modal with link + code + buttons
    const modal = new DeviceFlowModal(this.app, device.user_code, device.verification_url);
    modal.open();
    new Notice("Open the browser window and paste the code to authorize.", 4000);

    const start = Date.now();
    const interval = (device.interval ? device.interval : 5) * 1000;

    while (Date.now() - start < device.expires_in * 1000) {
      await sleep(interval);
      try {
        const tokenResp = await postJSON("https://oauth2.googleapis.com/token", {
          client_id: this.settings.googleClientId,
          client_secret: this.settings.googleClientSecret || undefined,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });

        this.settings.accessToken = tokenResp.access_token;
        this.settings.refreshToken = tokenResp.refresh_token;
        this.settings.tokenExpiresAt = Date.now() + tokenResp.expires_in * 1000;
        await this.saveSettings();

        // Refresh Settings UI immediately so "Session" block appears
        this.settingsTab?.display();
        this.updateStatusBar("ready");

        modal.setStatus("Connected ✅ You can close this window.");
        new Notice("Google Drive connected ✅");
        // Give the user a second to read, then close:
        setTimeout(() => modal.close(), 1000);
        return;
      } catch (err: any) {
        const txt = String(err);
        // Normal states while the user hasn’t approved yet:
        if (txt.includes("authorization_pending")) {
          modal.setStatus("Waiting for approval…");
          continue;
        }
        if (txt.includes("slow_down")) {
          modal.setStatus("Waiting (slow_down)…");
          await sleep(2000);
          continue;
        }
        // Any other error is real:
        modal.setStatus("Login failed. See console.");
        throw err;
      }
    }
    modal.setStatus("Device authorization timed out.");
    throw new Error("Device authorization timed out.");
  } catch (e) {
    console.error(e);
    new Notice("Google login failed (see console).");
  }
}


  async ensureAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.settings.accessToken && this.settings.tokenExpiresAt && now < this.settings.tokenExpiresAt - 30000) {
      return this.settings.accessToken;
    }
    if (!this.settings.refreshToken) throw new Error("Not logged in. Run: Connect Google Drive");

    const tokenResp = await postJSON("https://oauth2.googleapis.com/token", {
      client_id: this.settings.googleClientId,
      client_secret: this.settings.googleClientSecret || undefined,
      grant_type: "refresh_token",
      refresh_token: this.settings.refreshToken,
    });
    this.settings.accessToken = tokenResp.access_token;
    this.settings.tokenExpiresAt = Date.now() + tokenResp.expires_in * 1000;
    await this.saveSettings();
    return this.settings.accessToken!;
  }

  /** ---------------- Drive upload + permission ---------------- */
  async uploadToDrive(file: File): Promise<string> {
    if (!this.settings.googleClientId) throw new Error("Google Client ID not set.");
    const token = await this.ensureAccessToken();

    const name = this.buildFilename(file);
    const metadata: any = { name, mimeType: file.type || "image/png" };
    if (this.settings.driveFolderId) metadata.parents = [this.settings.driveFolderId];

    const boundary = "----obsidian-drive-uploader-" + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const metaPart = `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
    const fileBuffer = await file.arrayBuffer();
    const body = new Blob([
      delimiter,
      metaPart,
      `\r\n--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`,
      new Uint8Array(fileBuffer),
      closeDelim,
    ]);

    const uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    const uploaded = await postMultipart(uploadUrl, body, {
      "Authorization": `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`
    });

    const fileId = uploaded.id as string;
    if (!fileId) throw new Error("Drive response missing file id.");

    if (this.settings.makePublic) {
      try {
        await postJSON(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`,
          { role: "reader", type: "anyone" },
          { "Authorization": `Bearer ${token}` }
        );
      } catch (e) {
        console.warn("Failed to set public permission:", e);
      }
    }
    return fileId;
  }

  buildFilename(file: File): string {
    const ext = (file.name?.split(".").pop() || "png").toLowerCase();
    if (this.settings.useOriginalName && file.name) return file.name;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15); // yyyyMMddHHmmss
    return `${this.settings.filenamePrefix}${stamp}.${ext}`;
  }

  /** ---------------- Local fallback ---------------- */
  async saveLocal(file: File): Promise<string> {
    const folder = this.settings.localFolder.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "/");
    const array = new Uint8Array(await file.arrayBuffer());
    const name = this.buildFilename(file);
    const path = `${folder}/${name}`;

    // ensure folder exists (best effort)
    try { await this.app.vault.createFolder(folder); } catch {}

    await this.app.vault.createBinary(path, array.buffer);
    return path; // relative Markdown path
  }

  /** ---------------- Settings persistence ---------------- */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** ---------------- Settings tab ---------------- */
class DriveUploaderSettingsTab extends PluginSettingTab {
  plugin: DriveImageUploader;
  constructor(app: App, plugin: DriveImageUploader) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Drive Image Uploader" });

    new Setting(containerEl)
      .setName("Google Client ID (OAuth)")
      .setDesc("Required. From Google Cloud → OAuth client (TVs and Limited Input).")
      .addText(t => t
        .setPlaceholder("xxxxxxxxxx-abc123.apps.googleusercontent.com")
        .setValue(this.plugin.settings.googleClientId)
        .onChange(async v => { this.plugin.settings.googleClientId = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Google Client Secret (optional)")
      .setDesc("If your OAuth client shows a secret, paste it (some flows work without it).")
      .addText(t => t
        .setPlaceholder("")
        .setValue(this.plugin.settings.googleClientSecret)
        .onChange(async v => { this.plugin.settings.googleClientSecret = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Google API Key (for alt=media fallback)")
      .setDesc("Create an API key in Google Cloud. Optional but recommended.")
      .addText(t => t
        .setPlaceholder("AIzaSy...")
        .setValue(this.plugin.settings.googleApiKey)
        .onChange(async v => { this.plugin.settings.googleApiKey = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Target Drive Folder ID (optional)")
      .setDesc("Upload images into this Drive folder.")
      .addText(t => t
        .setPlaceholder("1AbCDeFg...")
        .setValue(this.plugin.settings.driveFolderId)
        .onChange(async v => { this.plugin.settings.driveFolderId = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Make files public")
      .setDesc("Set permission: anyone with the link → reader.")
      .addToggle(tg => tg
        .setValue(this.plugin.settings.makePublic)
        .onChange(async v => { this.plugin.settings.makePublic = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Use original file name")
      .setDesc("Otherwise use prefix + timestamp.")
      .addToggle(tg => tg
        .setValue(this.plugin.settings.useOriginalName)
        .onChange(async v => { this.plugin.settings.useOriginalName = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Filename prefix")
      .setDesc("Used when not using original name.")
      .addText(t => t
        .setPlaceholder("img_")
        .setValue(this.plugin.settings.filenamePrefix)
        .onChange(async v => { this.plugin.settings.filenamePrefix = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Fallback to local save")
      .setDesc("If cloud embed fails, save image inside the vault.")
      .addToggle(tg => tg
        .setValue(this.plugin.settings.fallbackToLocal)
        .onChange(async v => { this.plugin.settings.fallbackToLocal = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Local folder (under vault)")
      .setDesc("Used for local fallback.")
      .addText(t => t
        .setPlaceholder("DriveUploads")
        .setValue(this.plugin.settings.localFolder)
        .onChange(async v => { this.plugin.settings.localFolder = v.trim() || "DriveUploads"; await this.plugin.saveSettings(); }));

    containerEl.createEl("hr");

    new Setting(containerEl)
      .setName("Connect Google Drive")
      .setDesc("Start device flow. You'll get a code & link to authorize.")
      .addButton(b => b.setButtonText("Connect").onClick(async () => {
        await this.plugin.beginDeviceFlow();
      }));

    if (this.plugin.settings.refreshToken) {
      new Setting(containerEl)
        .setName("Session")
        .setDesc("A saved refresh token is present.")
        .addButton(b => b
          .setWarning()
          .setButtonText("Sign out (clear tokens)")
          .onClick(async () => {
            this.plugin.settings.accessToken = undefined;
            this.plugin.settings.refreshToken = undefined;
            this.plugin.settings.tokenExpiresAt = undefined;
            await this.plugin.saveSettings();
            new Notice("Signed out.");
            this.display();
          })
        );
    }
  }
}

