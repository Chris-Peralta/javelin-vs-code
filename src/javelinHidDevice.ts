// started from https://github.com/ServerBBQ/javelin-webtools/blob/main/lib/javelinHidDevice.ts
// ported from the WebHID API to the `node-hid` package for use outside the browser (e.g. a VS Code extension host)

import yaml from "js-yaml";
import { HIDAsync, devices, devicesAsync, type Device as NodeHidDeviceInfo } from "node-hid";
import { logError, logInfo } from "./logger";

/**
 * Whether HID access is available in this environment.
 * This attempts to load the native `node-hid` binding, which can fail to load
 * on unsupported platforms/architectures.
 */
export function isHidSupported(): boolean {
  try {
    devices();
    return true;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err) {
    return false;
  }
}

interface HidFilter {
  usagePage: number;
  usage: number;
}

const filters: HidFilter[] = [
  { usagePage: 65329, usage: 116 },
  { usagePage: 0x4c4a, usage: 0x0001 },
];

function matchesFilters(device: NodeHidDeviceInfo): boolean {
  return filters.some(
    (f) => device.usagePage === f.usagePage && (!f.usage || device.usage === f.usage)
  );
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (jsonError) {
    try {
      return yaml.load(data);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (yamlError) {
      throw new Error("Failed to parse data as JSON or YAML.");
    }
  }
}

// My documentation of the Javelin event system, TODO, move or delete this
// e: event
//   p: paper tape
//     o: outline
//     d: dictionary
//     t: translation
//   c: script // script events like layer changes
//     t: text
//   b: button_state // when pressing down buttons
//     d: data
//   s: suggestion
//     c: combined, how many strokes the suggestion covers(last x strokes)
//     t: translation
//     o: array of outlines
//   v: template value // when setting a template value
//     i: index
//     v: value
//   l: serial // when communicating over serial, used for serial bridge
//     d: data
//   d: dictionary status
//     d: dictionary
//     v: value, 1 or 0, 0 means disabled 1 means enabled
//   t: text // The text of the stuff typed in steno, used for wpm tool
//     t: text
//
//
// static constexpr const char *EVENT_NAMES[] = {
//     "button_state",      //
//     "dictionary_status", //
//     "paper_tape",        //
//     "script",            //
// #if JAVELIN_BLE
//     "serial", //
// #endif
//     "suggestion",     //
//     "template_value", //
//     "text",           //
//     "analog_data",    //
// };
//
// EV {"e":"b","d":"AAAAAAAAAAA="} // button state
// EV {"e":"d","d":"user.json","v":0} // dictionary status
// EV {"e":"p","o":"TH","d":"main.json","t":"this"} // paper tape
// EV {"e":"c","t":"layer_id: 87377230"} // script I think
// EV {"e":"l","d":"BAA="} // serial
// EV {"e":"s","c":2,"t":"this is","o":["TH-S","STKHE","STKH-B"]} // suggestion
// EV {"e":"v","i":0,"v":"test"} // template value
// EV {"e":"t","t":" Test"} // text

// List of events that should trigger `enable_events`
const JAVELIN_EVENT_NAMES: (keyof JavEventMap)[] = [
  "button_state",
  "dictionary_status",
  "paper_tape",
  "script",
  "serial",
  "suggestion",
  "template_value",
  "text",
  "analog_data",
] as const;

export interface JavEventMap {
  connected: NodeHidDeviceInfo;
  disconnected: NodeHidDeviceInfo;

  // Javelin events
  button_state: JavButtonStateEventDetail;
  dictionary_status: JavDictStatusEventDetail;
  paper_tape: JavPaperTapeEventDetail;
  script: JavScriptEventDetail;
  serial: JavSerialEventDetail;
  suggestion: JavSuggestionEventDetail;
  template_value: JavTemplateValueEventDetail;
  text: JavTextEventDetail;
  analog_data: JavAnalogDataEventDetail;
}

/**
 * The result of a lookup command.
 */
export interface LookupResult {
  outline: string;
  dictionary: string | null;
  translation: string;
  removable: boolean;
}

type CoercibleType = "number" | "boolean" | "boolean[]" | "string" | "string[]" | "unknown";

interface AliasMapping<T> {
  key: keyof T;
  type: CoercibleType;
}

/**
 * **Event:** `button_state`
 *
 * This happens when a user presses a key only if it is enabled in the layout
 */
export interface JavButtonStateEventDetail {
  /** Array of booleans, first element = first key, etc. */
  keys: boolean[];
  /** Raw event data */
  raw: string;
}

export const JavButtonStateAliases: Record<string, AliasMapping<JavButtonStateEventDetail>> = {
  d: { key: "keys", type: "boolean[]" },
  data: { key: "keys", type: "boolean[]" }, // Legacy event format
};

/**
 * **Event:** `dictionary_status`
 *
 * This happens when a dictionary is enable or disabled
 */
export interface JavDictStatusEventDetail {
  /** The name of the dictionary that changed */
  dictionary: string;
  /** The new state of the dictionary */
  enabled: boolean;
  /** Raw event data */
  raw: string;
}

const JavDictStatusAliases: Record<string, AliasMapping<JavDictStatusEventDetail>> = {
  d: { key: "dictionary", type: "string" },
  dictionary: { key: "dictionary", type: "string" },

  v: { key: "enabled", type: "boolean" },
  enabled: { key: "enabled", type: "boolean" }, // Legacy event format
};


/**
 * **Event:** `paper_tape`
 *
 * Fired each time a stroke is entered on the keyboard.
*/
export interface JavPaperTapeEventDetail {
  outline: string ;
  dictionary: string;
  translation: string;
  /**
   * The number of strokes to undo in order to get the correct translation
   * EX JAV/LIN
   * The undo count for the `LIN` stroke is 1
   */
  undo: number;
  /** Raw event data */
  raw: string;
}

const JavPaperTapeAliases: Record<string, AliasMapping<JavPaperTapeEventDetail>> = {
  o: { key: "outline", type: "string" },
  data: { key: "outline", type: "string" }, // Legacy event format

  d: { key: "dictionary", type: "string" },
  dictionary: { key: "dictionary", type: "string" }, // Legacy event format

  t: { key: "translation", type: "string" },
  definition: { key: "translation", type: "string" }, // Legacy event format

  u: { key: "undo", type: "number" },
  undo: { key: "undo", type: "number" }, // Legacy event format
};

/**
 * **Event:** `script`
 *
 * Events from Javelin script
 * @example
 * ```json
 * {"text":"layer_id: 87377230"}
 * ```
 */
export interface JavScriptEventDetail {
  text: string
  /** Raw event data */
  raw: string;
}

const JavScriptAliases: Record<string, AliasMapping<JavScriptEventDetail>> = {
  t: { key: "text", type: "string" },
  text: { key: "text", type: "string" }, // Legacy event format
};

/**
 * **Event:** `template_value`
 *
 * Fired when a template value changes
 */
export interface JavTemplateValueEventDetail {
  /** The index of template value changed */
  index: number;
  /** The new value of the template value */
  value: string;
  /** Raw event data */
  raw: string;
}

const JavTemplateValueAliases: Record<string, AliasMapping<JavTemplateValueEventDetail>> = {
  i: { key: "index", type: "number" },
  index: { key: "index", type: "number" }, // Legacy event format

  v: { key: "value", type: "string" },
  value: { key: "value", type: "string" }, // Legacy event format
};

/**
 * **Event:** `serial`
 *
 * This only exists if the keyboard has BLE(Bluetooth), I am unsure if it only works over bluetooth or works over usb too, TODO check
 * This is the raw serial output
 */
export interface JavSerialEventDetail {
  /** base64 encoded data based on the steno protocol used */
  data: string; // d
  /** Raw event data */
  raw: string;
}

const JavSerialAliases: Record<string, AliasMapping<JavSerialEventDetail>> = {
  d: { key: "data", type: "string" },
};


/**
 * **Event:** `suggestion`
 *
 * Fired when the keyboard identifies a more efficient outline for a given translation.
*/
export interface JavSuggestionEventDetail {
  /** How many strokes the suggestion covers*/
  strokes: number;
  /** The text that has a suggestion */
  translation: string;
  /**
   * An array of outlines
   * @example
   * ["TH-S", "STKHE", "STKH-B"]
   */
  outlines: string[];
  /** Raw event data */
  raw: string;
}

const JavSuggestionAliases: Record<string, AliasMapping<JavSuggestionEventDetail>> = {
  c: { key: "strokes", type: "number" },
  combine_count: { key: "strokes", type: "number" }, // Legacy event format

  t: { key: "translation", type: "string" },
  text: { key: "translation", type: "string" }, // Legacy event format

  o: { key: "outlines", type: "string[]" },
  outlines: { key: "outlines", type: "string[]" }, // Legacy event format
};

/**
 * **Event:** `text`
 *
 * The output in text for steno, this is used in the writing speed tool
*/
export interface JavTextEventDetail {
  event: "text";
  text: string;
  /** Raw event data */
  raw: string;
}

const JavTextAliases: Record<string, AliasMapping<JavTextEventDetail>> = {
  t: { key: "text", type: "string" },
};


/**
 * **Event:** `analog_data`
 *
 * Provides analog data for sliders.
 * This currently is only used on [Jeff's personal device](https://discord.com/channels/136953735426473984/1034560725047316530/1413829434770722936)
 * Each event reports the current positions of the sliders on the device.
 */
export interface JavAnalogDataEventDetail {
  /** Raw event data */
  raw: string;
}

const JavAnalogDataAliases: Record<string, AliasMapping<JavAnalogDataEventDetail>> = {

};

/**
 * Used to convert the Javelin event into a human readable one
 */
const JavAliasToEventName: Record<string, keyof JavEventMap> = {
  b: 'button_state',
  button_state: 'button_state',

  d: 'dictionary_status',
  dictionary_status: 'dictionary_status',

  p: 'paper_tape',
  paper_tape: 'paper_tape',

  c: 'script',
  script: 'script',

  l: 'serial',
  // Could not find legacy event name/usage

  s: 'suggestion',
  suggestion: 'suggestion',

  v: 'template_value',
  template_value: 'template_value',

  t: 'text',
  // Could not find legacy event name/usage

  a: 'analog_data',
  // Could not find legacy event name/usage
};

type EventAliases = {
  b: Record<string, AliasMapping<JavButtonStateEventDetail>>,
  button_state: Record<string, AliasMapping<JavButtonStateEventDetail>>,

  d: Record<string, AliasMapping<JavDictStatusEventDetail>>,
  dictionary_status: Record<string, AliasMapping<JavDictStatusEventDetail>>,

  p: Record<string, AliasMapping<JavPaperTapeEventDetail>>,
  paper_tape: Record<string, AliasMapping<JavPaperTapeEventDetail>>,

  c: Record<string, AliasMapping<JavScriptEventDetail>>,
  script: Record<string, AliasMapping<JavScriptEventDetail>>,

  l: Record<string, AliasMapping<JavSerialEventDetail>>,

  s: Record<string, AliasMapping<JavSuggestionEventDetail>>,
  suggestion: Record<string, AliasMapping<JavSuggestionEventDetail>>,

  v: Record<string, AliasMapping<JavTemplateValueEventDetail>>,
  template_value: Record<string, AliasMapping<JavTemplateValueEventDetail>>,

  t: Record<string, AliasMapping<JavTextEventDetail>>,
  a: Record<string, AliasMapping<JavAnalogDataEventDetail>>,
};

const JavAliases: EventAliases = {
  b: JavButtonStateAliases,
  button_state: JavButtonStateAliases,

  d: JavDictStatusAliases,
  dictionary_status: JavDictStatusAliases,

  p: JavPaperTapeAliases,
  paper_tape: JavPaperTapeAliases,

  c: JavScriptAliases,
  script: JavScriptAliases,

  l: JavSerialAliases,
  s: JavSuggestionAliases,
  suggestion: JavSuggestionAliases,

  v: JavTemplateValueAliases,
  template_value: JavTemplateValueAliases,

  t: JavTextAliases,
  a: JavAnalogDataAliases,
};

/**
 * Decodes a Base64-encoded string into a boolean array representing bits.
 * Each bit of the decoded bytes becomes one element in the array:
 *   - true  = bit is set (1)
 *   - false = bit is clear (0)
 * The first bit of the first byte is the first element of the array, etc.
 */
export function decodeBase64ToBoolArray(data: string): boolean[] {
  const bytes = Buffer.from(data, "base64");
  const bits: boolean[] = [];
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      bits.push((byte & (1 << i)) !== 0);
    }
  }
  return bits;
}

export type DecodedJavEvent<K extends keyof JavEventMap> = {
  event: K;
  detail: JavEventMap[K] & { raw: string };
};

/** Convert a raw event object to a typed, human-readable object */
export function decodeJavEvent<K extends keyof JavEventMap>(
  ev: { e: string; [key: string]: unknown }
): DecodedJavEvent<keyof JavEventMap> | null {
  // save event
  const unmodifiedEvent = { ...ev };

  // Support legacy events
  if (ev.event !== undefined) {
    ev.e = ev.event as string;
    delete ev.event;
  }

  const eventKey = JavAliasToEventName[ev.e] as K | undefined;
  if (!eventKey) return null;

  // Check if this event has aliases we know how to parse
  if (!(ev.e in JavAliases)) return null;
  const aliases = JavAliases[ev.e as keyof EventAliases];

  // Build as a plain record first
  const detailRecord: Record<string, unknown> = { raw: JSON.stringify(unmodifiedEvent) };

  function coerceValue(value: unknown, type: CoercibleType): unknown {
    if (value === null || value === undefined) {
      if (type === "boolean[]") return [];
      if (type === "string[]") return [];
      return value;
    }

    switch (type) {
      case "boolean":
        if (value === "1" || value === 1 || value === "true") return true;
        if (value === "0" || value === 0 || value === "false") return false;
        return Boolean(value);
      case "boolean[]":
        if (typeof value === "string") return decodeBase64ToBoolArray(value);
        return Array.isArray(value) ? value.map(Boolean) : [];
      case "number":
        return typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : value;
      case "string":
        return String(value);
      case "string[]":
        return Array.isArray(value) ? value.map(String) : [];
      default:
        return value;
    }
  }

  for (const [key, value] of Object.entries(ev)) {
    if (key === "e") continue;
    const alias = aliases[key];
    if (!alias) continue;

    const coerced = coerceValue(value, alias.type);
    detailRecord[alias.key as string] = coerced;
  }

  // Final cast: detailRecord -> concrete event type
  return {
    event: eventKey,
    detail: detailRecord as unknown as JavEventMap[K] & { raw: string },
  };
}

/**
 *  Manages a single Javelin HID device using the `node-hid` package.
 */
export class JavelinHidDevice extends EventTarget {
  /** The underlying open device handle, or null if not connected. */
  device: HIDAsync | null = null;

  /** Info (vendorId/productId/path/etc.) for the currently connected device, or null if not connected. */
  deviceInfo: NodeHidDeviceInfo | null = null;

  /** Whether the device is currently connected. */
  connected = false;

  /**
   * The id given by the `hello` console command
   */
  connectionId?: string = undefined;

  private sendCommandLock = new Lock();

  /** How often to poll for HID devices being plugged/unplugged, in ms. */
  private hotplugPollIntervalMs = 1000;
  private hotplugTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Set while a connection attempt is in flight, so overlapping calls to `openDevice`
   * (e.g. two hotplug poll ticks racing while `openDeviceWithRetry` is still retrying)
   * join the existing attempt instead of opening the device a second time.
   */
  private connectPromise: Promise<void> | null = null;

  constructor() {
    super();

    if (!isHidSupported()) {
      return;
    }

    this.checkForConnections().catch((err) => {
      logError("Initial device connection attempt failed:", err);
    });
    this.startHotplugWatcher();
  }

  /**
   * Stops the hotplug watcher and closes the device, if any.
   * Call this when the `JavelinHidDevice` instance is no longer needed, since
   * (unlike in a browser tab) nothing else will clean up the polling timer or
   * native device handle for you.
   */
  async destroy(): Promise<void> {
    if (this.hotplugTimer) {
      clearInterval(this.hotplugTimer);
      this.hotplugTimer = undefined;
    }
    await this.handleDisconnect();
  }

  /**
   * Lists currently connected HID devices matching the Javelin usage page/usage filters.
   * Use this to build a device picker, since there is no OS-level "request device" prompt outside the browser.
   */
  async listAvailableDevices(): Promise<NodeHidDeviceInfo[]> {
    return this.findMatchingDevices();
  }

  /**
   * Connects to a Javelin HID device.
   *
   * @param path - The `path` of a specific device (from `listAvailableDevices()`) to connect to.
   *   If omitted, connects to the first matching device found.
   * @returns The connected device's info, or null if no matching device was found.
   */
  async connect(path?: string): Promise<NodeHidDeviceInfo | null> {
    const matches = await this.findMatchingDevices();
    const target = path ? matches.find((d) => d.path === path) : matches[0];

    if (!target) {
      logError("No matching HID device found.");
      return null;
    }

    await this.openDevice(target);
    return this.deviceInfo;
  }

  /**
   * Sends a command to the device as a string and waits for a string response.
   *
   * @param command - The command string to send
   * @param timeout - Optional timeout in ms
   * @returns A Promise that resolves to the response string from the device
    * @example
    * ```ts
    * // Basic usage
    * const response = await device.sendCommand("help");
    * console.log(response);
    *
    * // With a custom timeout
    * const response2 = await device.sendCommand("info", 2000);
    * console.log(response2);
    * ```
   */
  async sendCommand(
    command: string,
    timeout?: number
  ): Promise<string> {
    const encoder = new TextEncoder();

    const header = this.connectionId ? this.connectionId + " " : "";

    const decoder = new TextDecoder();
    const headerBytes = encoder.encode(header)
    const commandBytes = encoder.encode(command + "\n");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const originalDevice = this.device;


    return this.sendCommandLock.runExclusive(async () => {
      return new Promise((resolve, reject) => {
        if (!this.device) {
          reject(new Error("No device connected"));
          return;
        }
        // Catch edge case where device disconnects or changes while acquiring lock
        if (this.device !== originalDevice) {
          reject(new Error("Device changed while acquiring lock"));
          return;
        }
        const device = this.device;

        let responseBuffer = "";
        let collecting = false; // Start collecting only after we see our connectionId

        if (!this.connectionId) {
          collecting = true; // Collect always if no connection id set
        }

        const handler = (data: Buffer) => {
          const chunk = decoder.decode(data);
          responseBuffer += chunk;

          // Only start collecting once we see the connection id
          if (!collecting) {
            const marker = this.connectionId + " ";
            const idx = responseBuffer.indexOf(marker);
            if (idx !== -1) {
              // Trim everything up to and including the connection id
              responseBuffer = responseBuffer.slice(idx + marker.length);
              collecting = true;
            } else {
              // Haven’t seen our connectionId yet, ignore this chunk
              responseBuffer = "";
              return;
            }
          }

          // Check for double newline
          if (responseBuffer.includes("\n\n")) {
            device.off("data", handler);
            this.off("disconnected", disconnectHandler);

            // trim responceBuffer
            responseBuffer = responseBuffer.split("\n\n")[0];
            responseBuffer = responseBuffer.replace(/^\x00+/, ''); // Strip null characters
            resolve(responseBuffer);
            clearTimeout(timer);
          }
        };

        device.on("data", handler);

        const disconnectHandler = () =>{
          logError("Device disconnected while running command");
          device.off("data", handler);
          this.off("disconnected", disconnectHandler);
          reject(new Error("Device disconnected"));
        }

        this.on("disconnected", disconnectHandler);

        if (timeout && timeout > 0) {
          timer = setTimeout(() => {
            device.off("data", handler);
            this.off("disconnected", disconnectHandler);
            reject(new Error("Command timed out"));
          }, timeout);
        }

        const splitCommandBytes = splitUint8Array(commandBytes, 63 - headerBytes.length);

        (async () => {
          for (const commandBytesChunk of splitCommandBytes) {
            const fullPacket = new Uint8Array(63);
            fullPacket.set(headerBytes, 0);
            fullPacket.set(commandBytesChunk, headerBytes.length);

            try {
              // node-hid requires a leading Report Id byte (0 since this device doesn't use numbered reports)
              await device.write([0, ...fullPacket]);
            } catch (err) {
              device.off("data", handler);
              this.off("disconnected", disconnectHandler);
              reject(err);
              return;
            }
          }
        })();
      });
    });
  }

  /**
   * Looks up outlines for given text from the Javelin device.
   * @param text The text to look up.
   * @returns A promise that resolves to an array of lookup results.
   * @example
   * ```ts
   * const results = await device.lookup("test");
   * for (const result of results) {
   *   console.log(`Outline: ${result.outline}, Removable: ${result.removable}`);
   * }
   * ```
   */
  async lookup(text: string): Promise<LookupResult[]> {
    const response = await this.sendCommand(`lookup ${text}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawResults = parseData(response) as any[];

    if (!rawResults || rawResults.length === 0) {
      return [];
    }

    // Check for legacy firmware format
    if ('outline' in rawResults[0]) {
      return rawResults.map((item: { outline: string; dictionary?: string; definition: string; can_remove?: boolean }) => ({
        outline: item.outline,
        dictionary: item.dictionary || null,
        translation: item.definition,
        removable: item.can_remove || false,
      }));
    }

    // Modern firmware format
    const resolvedDictionaries: (string | null)[] = new Array(rawResults.length).fill(null);
    const resolvedTranslations: string[] = new Array(rawResults.length).fill(text);

    // Map for dictionaries to be used in dictionary lookup
    const dictionaries: string[] = []

    /** This function must be called in order from first item to last, then once looped over once it can be called in any order */
    const getDictionary = (item: { d: string | number; r?: 1 }): string | null => {
      if (typeof item.d === 'string') {
        dictionaries.push(item.d);
        return item.d;
      }

      if (typeof item.d === 'number') {
        return dictionaries[item.d];
      }
      return null;
    };

    // Map for translations to be used in translation lookup
    const translations: string[] = [];

    /** This function must be called in order from first item to last, then once looped over once it can be called in any order */
    const getTranslation = (item: { t?: string }): string => {
      if (typeof item.t === 'string') {
        translations.push(item.t);
        return item.t;
      }

      if (typeof item.t === 'number') {
        return translations[item.t];
      }

      return text;
    };


    // First pass: resolve all dictionary values
    rawResults.forEach((result: { d: string | number; t?: string; r?: 1 }, index: number) => {
      resolvedDictionaries[index] = getDictionary(result);
      resolvedTranslations[index] = getTranslation(result);
    });

    return rawResults.map((item: { o: string; d: string | number; t?: string; r?: 1 }, index: number) => {
      return {
        outline: item.o,
        dictionary: resolvedDictionaries[index],
        translation: resolvedTranslations[index],
        removable: item.r === 1,
      };
    });
  }

  async getConnectionId(){
    const helloOutput = await this.sendCommand("hello");
    const id = helloOutput.slice(0, 3);
    if (!id.match(/^c\d\d$/)) {
      logError("Error getting connection ID. Output from hello command:", helloOutput);
      return null;
    }

    this.connectionId = id;
    return id;
  }

  // -----------------------
  // Typed event API (for IDE autocomplete)
  // -----------------------
  private enabledEvents: string[] = []
  on<K extends keyof JavEventMap>(
    eventType: K,
    listener: (ev: CustomEvent<JavEventMap[K]>) => void,
    options?: boolean | AddEventListenerOptions
  ) {

    // Enable event in Javelin if needed
    if (JAVELIN_EVENT_NAMES.includes(eventType)) {
      if (!this.enabledEvents.includes(eventType)) {
        this.enabledEvents.push(eventType);
      }
      if (this.connected) {
        this.sendCommand(`enable_events ${eventType}`).catch(err => {
          logError(`Failed to enable event ${eventType}:`, err);
        });
      }
    }

    // Register event listener
    super.addEventListener(eventType as string, listener as EventListener, options);
  }

  off<K extends keyof JavEventMap>(
    type: K,
    listener: (ev: CustomEvent<JavEventMap[K]>) => void,
    options?: boolean | EventListenerOptions
  ) {
    super.removeEventListener(type as string, listener as EventListener, options);
  }

  protected emit<K extends keyof JavEventMap>(
    type: K,
    detail: JavEventMap[K]
  ) {
    this.dispatchEvent(new CustomEvent(type as string, { detail }));
  }

  /**
   * Checks for currently connected devices that match the Javelin usage page/usage filters
   * and automatically connects if exactly one matches.
  */
  async checkForConnections() {
    if (this.connected) return;

    const matches = await this.findMatchingDevices();
    logInfo(`checkForConnections: found ${matches.length} matching device(s)`);
    if (matches.length === 1) {
      await this.openDevice(matches[0]);
    }
  }

  /**
   * Periodically polls for HID devices being plugged in or unplugged, since `node-hid`
   * has no built-in hotplug notification API.
   */
  private startHotplugWatcher() {
    this.hotplugTimer = setInterval(() => {
      this.pollDevices().catch((err) => {
        logError("Failed polling for HID devices:", err);
      });
    }, this.hotplugPollIntervalMs);
    // Don't keep the process alive just for this timer
    this.hotplugTimer.unref?.();
  }

  private async pollDevices() {
    const matches = await this.findMatchingDevices();

    if (this.connected) {
      const stillPresent = matches.some((d) => d.path === this.deviceInfo?.path);
      if (!stillPresent) {
        await this.handleDisconnect();
      }
      return;
    }

    if (matches.length === 1) {
      await this.openDevice(matches[0]);
    }
  }

  private async findMatchingDevices(): Promise<NodeHidDeviceInfo[]> {
    const allDevices = await devicesAsync();
    return allDevices.filter(matchesFilters);
  }

  private async openDevice(info: NodeHidDeviceInfo): Promise<void> {
    if (this.connected) return;

    // A connection attempt is already in flight (e.g. a previous hotplug poll tick
    // is still retrying `openDeviceWithRetry`) - join it instead of opening again.
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    if (!info.path) {
      throw new Error("Matched HID device has no path to open");
    }
    const path = info.path;
    logInfo(`Opening HID device at path ${path}`);

    this.connectPromise = (async () => {
      const device = await this.openDeviceWithRetry(path);

      this.device = device;
      this.deviceInfo = info;

      device.on("error", (err) => {
        logError("HID device error:", err);
        this.handleDisconnect().catch(() => { /* already disconnecting */ });
      });

      await this.setupDevice();
      this.connected = true;
      logInfo(
        `Connected to HID device at path ${path}` +
          (this.connectionId ? ` (connectionId ${this.connectionId})` : " (no connectionId)")
      );
      this.emit("connected", info);
    })();

    try {
      await this.connectPromise;
    } catch (err) {
      logError(`Failed to open HID device at path ${path}:`, err);
      throw err;
    } finally {
      this.connectPromise = null;
    }
  }

  private async handleDisconnect() {
    if (!this.connected || !this.device) return;

    const info = this.deviceInfo;
    const device = this.device;

    this.connected = false;
    this.device = null;
    this.deviceInfo = null;

    try {
      await device.close();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // Device may already be gone; ignore close errors
    }

    logInfo(`Disconnected from HID device${info ? ` at path ${info.path}` : ""}`);

    if (info) {
      this.emit("disconnected", info);
    }
  }

  // Event listening
  private eventDecoder = new TextDecoder();
  private eventBuffer = "";

  // Call once after device is connected/opened
  private startEventListener() {
    if (!this.device) return;

    const handler = (data: Buffer) => {
      const chunk = this.eventDecoder.decode(data);
      this.eventBuffer += chunk;

      // Split into complete lines
      const lines = this.eventBuffer.split("\n\n");
      this.eventBuffer = lines.pop() ?? ""; // save incomplete tail
      for (const rawLine of lines) {
        const line = rawLine.replace(/^\x00+/, ''); // This caused so much debugging
        if (line.startsWith("EV ")) {
          const dataPart = line.slice(3).trim();
          try {
            const ev = parseData(dataPart) as { e: string; [key: string]: unknown };

            const decoded = decodeJavEvent(ev);
            if (decoded) {
              this.emit(decoded.event, decoded.detail);
            } else {
              logError("Failed to parse event data:", ev);
            }

          } catch (err) {
            logError("Failed to parse event data:", dataPart, err);
          }
        }
      }
    };

    this.device.on("data", handler);
  }

  /**
   * Opens a HID device by path, retrying for a bit if it's transiently busy
   * (e.g. another process/handle is still releasing it).
   */
  private async openDeviceWithRetry(path: string, retryInterval = 100, maxAttempts = 20): Promise<HIDAsync> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await HIDAsync.open(path);
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, retryInterval));
      }
    }
    throw lastErr;
  }

  private async setupDevice(){
    if (!this.connectionId){
      await this.getConnectionId();
    }

    // Enable events
    this.startEventListener();

    if (this.enabledEvents.length > 0) {
      this.sendCommand(`enable_events ${this.enabledEvents.join(" ")}`).catch(err => {
        logError("Failed enabling events:", err);
      });
    }
  }

}

function splitUint8Array(array: Uint8Array, chunkSize: number) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

class Lock {
  private locked = false;
  private waiting: (() => void)[] = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    // Wait until lock is released
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    if (this.waiting.length > 0) {
      // Give lock to next waiter
      const next = this.waiting.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
