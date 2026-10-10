(function (exports, patcher, metro, metroCommon, pluginApi) {
"use strict";
const { FluxDispatcher, moment } = metroCommon;
const { storage } = pluginApi;
const { findByProps, findByStoreName } = metro;
const patchBefore = patcher.before;

// fills in any setting that has no saved value yet (nested objects are merged, not replaced)
function makeDefaults(object, defaults) {
	for (const key of Object.keys(defaults)) {
		const value = defaults[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			if (!object[key] || typeof object[key] !== "object") object[key] = {};
			makeDefaults(object[key], value);
		} else if (object[key] === undefined) {
			object[key] = value;
		}
	}
}
makeDefaults(storage, {
	ignore: {
		users: [],
		channels: [],
		bots: false,
	},
	timestamps: false,
	ew: false,
	onlyTimestamps: false,
});

// ---- options (edit these here; no settings page entry needed) ----
const SHOW_EDITS = true; // show "old / [ EDITED ] / new" on edited messages
const EDIT_SEPARATOR = "\n\n`[ EDITED ]`\n\n";
const MAX_VERSIONS = 10; // versions kept per edited message
const MAX_TRACKED = 300; // edited messages remembered (oldest are forgotten first)

let MessageStore;
const patches = [];
const edits = new Map(); // messageId -> { history: [raw content, oldest -> newest] }
let alerted = false;

// log every error, but only pop an alert once so a repeating error can't freeze the app
function reportOnce(where, e) {
	console.error(`[NoDelete] ${where}`, e);
	if (alerted) return;
	alerted = true;
	alert(`[NoDelete → ${where}] died\n${e?.stack}`);
}

// false = this message's author is on the ignore list, so let the delete go through normally
function shouldKeep(channelId, id) {
	const message = MessageStore.getMessage(channelId, id);
	if (storage["ignore"]["users"].includes(message?.author?.id)) return false;
	if (storage["ignore"]["bots"] && message?.author?.bot) return false;
	return true;
}

// the fake "automod blocked this" event that makes Discord keep the message and show a note
function placeholder(channelId, id) {
	let text = "This message was deleted";
	if (storage["timestamps"]) text += ` (${moment().format(storage["ew"] ? "hh:mm:ss.SS a" : "HH:mm:ss.SS")})`;
	return {
		type: "MESSAGE_EDIT_FAILED_AUTOMOD",
		messageData: {
			type: 1,
			message: { channelId, messageId: id },
		},
		errorResponseBody: {
			code: 200000,
			message: text,
		},
	};
}

function handleDelete(args, event) {
	if (!event.id || !event.channelId) return;
	if (!shouldKeep(event.channelId, event.id)) return;
	args[0] = placeholder(event.channelId, event.id);
	return args;
}

function handleBulkDelete(args, event) {
	const ids = Array.isArray(event.ids) ? event.ids : [];
	if (!ids.length || !event.channelId) return;

	const keep = ids.filter((id) => shouldKeep(event.channelId, id));
	if (!keep.length) return; // everything is ignored: let the bulk delete through untouched

	const keepSet = new Set(keep);
	const drop = ids.filter((id) => !keepSet.has(id));

	let rest;
	if (drop.length) {
		// ignored authors' messages still get deleted, the rest are kept
		args[0] = { ...event, ids: drop };
		rest = keep;
	} else {
		// this event can only carry one message, so it becomes the first placeholder
		args[0] = placeholder(event.channelId, keep[0]);
		rest = keep.slice(1);
	}
	// the remaining placeholders are sent right after this dispatch finishes, never inside it
	if (rest.length) {
		setTimeout(() => {
			for (const id of rest) {
				try {
					FluxDispatcher.dispatch(placeholder(event.channelId, id));
				} catch (e) {
					console.error("[NoDelete] bulk placeholder", e);
				}
			}
		}, 0);
	}
	return args;
}

function handleEdit(args, event) {
	const msg = event.message;
	if (!msg || typeof msg.content !== "string") return; // partial update (embeds, flags...): leave alone
	const channelId = msg.channel_id || event.channelId;
	const id = msg.id || event.id;
	if (!channelId || !id) return;

	let rec = edits.get(id);
	if (!rec) {
		const current = MessageStore.getMessage(channelId, id);
		if (!current || typeof current.content !== "string" || !current.content) return;
		if (storage["ignore"]["users"].includes(current.author?.id)) return;
		if (storage["ignore"]["bots"] && current.author?.bot) return;
		if (current.content === msg.content) return; // nothing changed (an embed loaded, etc.)
		rec = { history: [current.content] };
		edits.set(id, rec);
		if (edits.size > MAX_TRACKED) edits.delete(edits.keys().next().value);
	}

	// compare with the last RAW version, not the combined text the message currently displays
	if (rec.history[rec.history.length - 1] !== msg.content) {
		rec.history.push(msg.content);
		if (rec.history.length > MAX_VERSIONS) rec.history.shift();
	}

	args[0] = { ...event, message: { ...msg, content: rec.history.join(EDIT_SEPARATOR) } };
	return args;
}

const plugin = {
	onUnload() {
		for (const unpatch of patches) unpatch();
		patches.length = 0;
		edits.clear();
	},
	onLoad() {
		try {
			patches.push(
				patchBefore("dispatch", FluxDispatcher, (args) => {
					try {
						const event = args[0];
						const type = event?.type;
						if (type !== "MESSAGE_DELETE" && type !== "MESSAGE_DELETE_BULK" && type !== "MESSAGE_UPDATE") return;
						if (type === "MESSAGE_UPDATE" && !SHOW_EDITS) return;

						if (!MessageStore) MessageStore = findByStoreName("MessageStore");

						if (type === "MESSAGE_DELETE") return handleDelete(args, event);
						if (type === "MESSAGE_DELETE_BULK") return handleBulkDelete(args, event);
						return handleEdit(args, event);
					} catch (e) {
						reportOnce("dispatcher patch", e);
					}
				})
			);

			// when you press Edit on one of your own edited messages, start from the newest text only
			const messageActions = findByProps("sendMessage", "startEditMessage");
			if (SHOW_EDITS && messageActions) {
				patches.push(
					patchBefore("startEditMessage", messageActions, (args) => {
						try {
							if (typeof args[2] === "string" && args[2].includes(EDIT_SEPARATOR)) {
								args[2] = args[2].split(EDIT_SEPARATOR).pop();
							}
							return args;
						} catch (e) {
							console.error("[NoDelete] startEditMessage", e);
						}
					})
				);
			}
		} catch (e) {
			console.error(e);
			alert(`[NoDelete] dead\n${e.stack}`);
		}
	},
};

exports.default = plugin;
Object.defineProperty(exports, "__esModule", { value: true });
return exports;
})({}, vendetta.patcher, vendetta.metro, vendetta.metro.common, vendetta.plugin);
