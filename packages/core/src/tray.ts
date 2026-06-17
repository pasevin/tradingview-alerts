/**
 * Tray facade. macOS has no menu-bar badge API, so the original Glaze app drove
 * the unread count two ways at once — a title string and an icon swap. We
 * preserve both controls: `setTitle` for the exact count and `setImage` for the
 * template-image state (idle / active / disconnected).
 */
import { TrayIcon, type TrayIconOptions } from "@tauri-apps/api/tray";
import { Menu as TauriMenu } from "@tauri-apps/api/menu";

/** A single shared tray instance, matching Glaze's `new Tray(icon)` singleton. */
export class Tray {
  private inner: TrayIcon | null = null;
  private readonly ready: Promise<void>;

  constructor(private readonly iconPath?: string) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const opts: TrayIconOptions = {
      // Template image: monochrome + alpha so macOS auto-inverts per theme.
      icon: this.iconPath,
      iconAsTemplate: true,
      title: "",
    };
    this.inner = await TrayIcon.new(opts);
  }

  /** Exact unread count shown beside the menu-bar glyph (e.g. "9+"). */
  async setTitle(title: string): Promise<void> {
    await this.ready;
    await this.inner?.setTitle(title);
  }

  /** Swap the template image to reflect state (idle / alert / offline). */
  async setImage(path: string): Promise<void> {
    await this.ready;
    await this.inner?.setIcon(path);
  }

  async setContextMenu(menu: TauriMenu): Promise<void> {
    await this.ready;
    await this.inner?.setMenu(menu);
  }

  async setToolTip(tooltip: string): Promise<void> {
    await this.ready;
    await this.inner?.setTooltip(tooltip);
  }
}
