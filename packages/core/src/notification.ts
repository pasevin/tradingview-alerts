/**
 * Notification facade — maps Glaze's `new Notification({title, body}).show()`
 * onto the Tauri notification plugin, including permission negotiation.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface NotificationOptions {
  title: string;
  body?: string;
  /** Named system sound or bundled file; falls back to the default chime. */
  sound?: string;
}

export class Notification {
  constructor(private readonly options: NotificationOptions) {}

  /**
   * Permission is requested lazily on first show rather than at startup, so a
   * user who never enables alerts is never prompted.
   */
  async show(): Promise<void> {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) return;

    sendNotification({
      title: this.options.title,
      body: this.options.body,
      sound: this.options.sound,
    });
  }

  static async isSupported(): Promise<boolean> {
    return isPermissionGranted();
  }
}
