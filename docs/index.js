(function (exports, patcher, metro, metroCommon, pluginApi) {
"use strict";
const { FluxDispatcher, moment } = metroCommon;
const { storage } = pluginApi;
const { findByProps, findByStoreName } = metro;
const patchBefore = patcher.before;
const patchAfter = patcher.after;

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
const EPHEMERAL = 64; // message flag for ephemeral (Clyde / bot "only you can see this") messages

let MessageStore;
const patches = [];
const edits = new Map(); // messageId -> { history: [raw content, oldest -> newest], ts: last edited_timestamp }
const deletedIds = new Set(); // messages NoDelete is holding as "This message was deleted"
let alerted = false;

// log every error, but only pop an alert once so a repeating error can't freeze the app
function reportOnce(where, e) {
	console.error(`[NoDelete] ${where}`, e);
	if (alerted) return;
	alerted = true;
	alert(`[NoDelete → ${where}] died\n${e?.stack}`);
}

// ---------------------------------------------------------------- debug trail + crash capture
// DEBUG keeps a short log of what the plugin just did (saved to storage as it goes) and, when the app throws a
// fatal / native error, copies  error + stack + that log  to the clipboard (and again on the next launch).
const DEBUG = true;
const TRAIL_MAX = 40;
let trail = [];
function preview(s) {
	return typeof s === "string" ? `${JSON.stringify(s.length > 60 ? s.slice(0, 60) + "…" : s)} (len ${s.length})` : `<${typeof s}>`;
}
function dbg(tag, info) {
	if (!DEBUG) return;
	try {
		trail.push(`${new Date().toISOString().slice(11, 23)} ${tag}${info ? " " + info : ""}`);
		if (trail.length > TRAIL_MAX) trail.shift();
		storage.debugTrail = trail.slice(); // saved right away so it survives a hard crash
	} catch (_) {}
}
function copyText(text) {
	try {
		const clip = metroCommon.clipboard || findByProps("setString", "getString");
		if (clip && clip.setString) { clip.setString(text); return true; }
	} catch (_) {}
	return false;
}
function toast(msg) {
	try { vendetta.ui.toasts.showToast(msg); } catch (_) {}
}
function crashReport(err, fatal) {
	const msg = err && (err.message || String(err));
	const stack = err && err.stack ? String(err.stack).slice(0, 3000) : "";
	return [
		"NoDelete Plus debug report",
		`fatal=${!!fatal} edits=${SHOW_EDITS} (original build + debug only)`,
		"ERROR: " + msg,
		"STACK: " + stack,
		"TRAIL (oldest -> newest):",
		...trail,
	].join("\n");
}
let prevHandler = null;
let ourHandler = null;
let lastCaptured = 0;
function installCrashCapture() {
	if (!DEBUG) return;
	try {
		const EU = globalThis.ErrorUtils;
		if (!EU || !EU.getGlobalHandler || !EU.setGlobalHandler) return;
		prevHandler = EU.getGlobalHandler();
		ourHandler = (err, fatal) => {
			try {
				const text = String((err && err.message) || err);
				const looksNative = /native call|deserializ|serializ/i.test(text);
				if ((fatal || looksNative) && Date.now() - lastCaptured > 10000) {
					lastCaptured = Date.now();
					const report = crashReport(err, fatal);
					storage.pendingReport = report; // copied again on the next launch/reload
					storage.lastReport = report; // kept so the debug page can always show it
					copyText(report);
					toast("NoDelete: error report copied to clipboard");
				}
			} catch (_) {}
			if (prevHandler) return prevHandler(err, fatal);
		};
		EU.setGlobalHandler(ourHandler);
	} catch (e) {
		console.error("[NoDelete] crash capture", e);
	}
}
function removeCrashCapture() {
	try {
		const EU = globalThis.ErrorUtils;
		if (EU && ourHandler && EU.getGlobalHandler() === ourHandler && prevHandler) EU.setGlobalHandler(prevHandler);
	} catch (_) {}
	ourHandler = null;
}
// a report from the previous run that has not been handed over yet
function deliverPendingReport() {
	try {
		if (!DEBUG || !storage.pendingReport) return;
		storage.lastReport = storage.pendingReport;
		const ok = copyText(storage.pendingReport);
		storage.pendingReport = null;
		toast(ok ? "NoDelete: last error report copied to clipboard" : "NoDelete: could not copy the error report");
	} catch (_) {}
}

// true if this is a read-only ephemeral message (Clyde warning, bot "only you can see this"),
// which Discord lets you Dismiss - we must let that delete go through instead of keeping it
function isEphemeral(message) {
	return !!(message && typeof message.flags === "number" && (message.flags & EPHEMERAL) === EPHEMERAL);
}

// false = let the delete go through normally (ignored author, or a dismissable ephemeral message)
function shouldKeep(channelId, id) {
	const message = MessageStore.getMessage(channelId, id);
	let keep = true;
	if (isEphemeral(message)) keep = false; // let Dismiss actually remove Clyde / ephemeral bot messages
	else if (storage["ignore"]["users"].includes(message?.author?.id)) keep = false;
	else if (storage["ignore"]["bots"] && message?.author?.bot) keep = false;
	dbg("shouldKeep", `ch=${channelId} id=${id} inStore=${!!message} flags=${message?.flags} type=${message?.type} -> ${keep}`);
	return keep;
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
	if (event.__noDeleteBypass) return; // our own "Delete Kept Message" action: let it delete
	if (!shouldKeep(event.channelId, event.id)) return;
	deletedIds.add(event.id);
	args[0] = placeholder(event.channelId, event.id);
	return args;
}

function handleBulkDelete(args, event) {
	const ids = Array.isArray(event.ids) ? event.ids : [];
	if (!ids.length || !event.channelId) return;

	const keep = ids.filter((id) => shouldKeep(event.channelId, id));
	dbg("BULK delete", `ch=${event.channelId} total=${ids.length} keep=${keep.length}`);
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
		deletedIds.add(keep[0]);
		rest = keep.slice(1);
	}
	// the remaining placeholders are sent right after this dispatch finishes, never inside it
	if (rest.length) {
		setTimeout(() => {
			for (const id of rest) {
				try {
					deletedIds.add(id);
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
	// updates tagged by other plugins (e.g. the translator) are not real edits
	if (event.otherPluginBypass || event.log_edit === false) return;

	const msg = event.message;
	if (!msg || typeof msg.content !== "string") return; // partial update (embeds, flags...): leave alone

	// Real edits from Discord carry an edited_timestamp. Local updates don't,
	// so let those pass through untouched.
	if (!msg.edited_timestamp) return;

	const channelId = msg.channel_id || event.channelId;
	const id = msg.id || event.id;
	if (!channelId || !id) return;

	let rec = edits.get(id);

	// same edit seen again (e.g. a local re-dispatch of an already-edited message)
	if (rec && rec.ts === msg.edited_timestamp) return;

	if (!rec) {
		const current = MessageStore.getMessage(channelId, id);
		if (!current || typeof current.content !== "string" || !current.content) return;
		if (storage["ignore"]["users"].includes(current.author?.id)) return;
		if (storage["ignore"]["bots"] && current.author?.bot) return;
		if (current.content === msg.content) return; // nothing changed (an embed loaded, etc.)
		rec = { history: [current.content], ts: msg.edited_timestamp };
		edits.set(id, rec);
		if (edits.size > MAX_TRACKED) edits.delete(edits.keys().next().value);
	}
	rec.ts = msg.edited_timestamp;

	// compare with the last RAW version, not the combined text the message currently displays
	if (rec.history[rec.history.length - 1] !== msg.content) {
		rec.history.push(msg.content);
		if (rec.history.length > MAX_VERSIONS) rec.history.shift();
	}

	const combined = rec.history.join(EDIT_SEPARATOR);
	dbg("EDIT rewrite", `id=${id} versions=${rec.history.length} incoming=${preview(msg.content)} combinedLen=${combined.length} msgType=${msg.type}`);
	args[0] = { ...event, message: { ...msg, content: combined } };
	return args;
}

// ---------------------------------------------------------------- long-press menu actions

// collapse an edited message back to its newest version and forget the stored history
function removeEditHistory(channelId, id) {
	const rec = edits.get(id);
	edits.delete(id);
	const current = MessageStore.getMessage(channelId, id);
	if (!current) return;
	const newest = rec ? rec.history[rec.history.length - 1] : undefined;
	const content = typeof newest === "string"
		? newest
		: (typeof current.content === "string" ? current.content.split(EDIT_SEPARATOR).pop() : current.content);
	// otherPluginBypass so handleEdit ignores this update and doesn't re-stitch the history back in
	dbg("REMOVE-HISTORY dispatch", `id=${id} ch=${channelId} content=${preview(content)} spreadKeys=${Object.keys(current).join(",")}`);
	FluxDispatcher.dispatch({
		type: "MESSAGE_UPDATE",
		message: { ...current, content },
		otherPluginBypass: true,
		log_edit: false,
	});
}

// actually remove a message NoDelete is holding (or any message you want gone from your view)
function deleteKeptMessage(channelId, id) {
	edits.delete(id);
	deletedIds.delete(id);
	dbg("DELETE-KEPT dispatch", `id=${id} ch=${channelId}`);
	FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id, channelId, __noDeleteBypass: true });
}

// fallback tree walker, only used if vendetta.utils.findInReactTree is missing
function localFindInReactTree(node, filter, depth = 0) {
	if (!node || depth > 30) return undefined;
	try {
		if (filter(node)) return node;
	} catch (_) {}
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = localFindInReactTree(child, filter, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof node === "object") {
		const kids = node.props?.children ?? node.children;
		if (kids !== undefined) return localFindInReactTree(kids, filter, depth + 1);
	}
	return undefined;
}

// ---------------------------------------------------------------- debug page (plugin settings)
function DebugSettings() {
	const React = metroCommon.React;
	const RN = metroCommon.ReactNative;
	const [, force] = React.useReducer((x) => x + 1, 0);
	const arr = (v) => { try { return v ? Array.prototype.slice.call(v) : []; } catch (_) { return []; } };
	const text = [
		storage.lastReport ? "LAST ERROR REPORT:\n" + storage.lastReport : "(no error report captured yet)",
		"",
		"PREVIOUS SESSION ACTIVITY (oldest -> newest):",
		...(arr(storage.prevTrail).length ? arr(storage.prevTrail) : ["(none)"]),
		"",
		"THIS SESSION ACTIVITY (oldest -> newest):",
		...(arr(storage.debugTrail).length ? arr(storage.debugTrail) : ["(none)"]),
	].join("\n");
	return React.createElement(
		RN.ScrollView,
		{ style: { flex: 1 }, contentContainerStyle: { padding: 12 } },
		React.createElement(RN.Button, {
			title: "Copy everything",
			onPress: () => { toast(copyText(text) ? "NoDelete: log copied" : "NoDelete: copy failed"); },
		}),
		React.createElement(RN.Button, {
			title: "Clear log",
			onPress: () => { trail = []; storage.debugTrail = []; storage.prevTrail = []; storage.lastReport = null; force(); },
		}),
		React.createElement(RN.Text, { selectable: true, style: { color: "#ffffff", fontSize: 11, marginTop: 8 } }, text)
	);
}

const plugin = {
	settings: DebugSettings,
	onUnload() {
		for (const unpatch of patches) unpatch();
		patches.length = 0;
		edits.clear();
		deletedIds.clear();
		removeCrashCapture();
	},
	onLoad() {
		try {
			try {
				// keep the previous session's activity log (the first dbg() below would overwrite it)
				const old = storage.debugTrail ? Array.prototype.slice.call(storage.debugTrail) : [];
				if (old.length > 1) storage.prevTrail = old;
			} catch (_) {}
			deliverPendingReport(); // hand over the report from a previous crash, if there is one
			installCrashCapture();
			dbg("LOADED", `edits=${SHOW_EDITS} (original build + debug only)`);
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

			// add the two long-press menu rows (same approach as the ViewThread plugin for this client)
			try {
				const React = metroCommon.React || findByProps("createElement");
				const findInReactTree =
					(vendetta.utils && vendetta.utils.findInReactTree) || localFindInReactTree;
				const ActionSheet = findByProps("openLazy", "hideActionSheet");
				const rowMod = findByProps("ActionSheetRow");
				const ActionSheetRow = rowMod && rowMod.ActionSheetRow;
				const getAssetIDByName = vendetta.ui && vendetta.ui.assets && vendetta.ui.assets.getAssetIDByName;
				const asset = (...names) => {
					if (!getAssetIDByName) return undefined;
					for (const n of names) {
						const id = getAssetIDByName(n);
						if (id) return id;
					}
					return undefined;
				};
				const TRASH = asset("ic_message_delete", "trash", "ic_trash_24px", "ic_trash");
				const PENCIL = asset("ic_edit_24px", "ic_edit", "pencil", "ic_pencil");

				if (React && ActionSheet && ActionSheetRow && findInReactTree) {
					patches.push(
						patchBefore("openLazy", ActionSheet, ([comp, key, sheetProps]) => {
							try {
								if (key !== "MessageLongPressActionSheet" || !(sheetProps && sheetProps.message)) return;
								const message = sheetProps.message;
								const channelId = message.channel_id;
								if (!message.id || !channelId) return;
								dbg("MENU open", `id=${message.id} ch=${channelId} hasHistory=${edits.has(message.id)}`);
								if (!comp || typeof comp.then !== "function") return;

								comp.then((instance) => {
									const unpatch = patchAfter("default", instance, (_a, component) => {
										try {
											// auto-remove this patch after it runs once for this sheet instance
											React.useEffect(() => () => { unpatch(); }, []);

											const makeButton = (label, icon, action) =>
												React.createElement(ActionSheetRow, {
													label,
													icon: icon ? React.createElement(ActionSheetRow.Icon, { source: icon }) : undefined,
													onPress: () => {
														try { ActionSheet.hideActionSheet(); } catch (_) {}
														try { action(); } catch (e) { console.error("[NoDelete] row action", e); }
													},
												});

											const buttons = [];
											if (edits.has(message.id)) {
												buttons.push(makeButton("Remove Edit History", PENCIL, () => removeEditHistory(channelId, message.id)));
											}
											buttons.push(makeButton("Delete Kept Message", TRASH, () => deleteKeptMessage(channelId, message.id)));

											const groups = findInReactTree(
												component,
												(c) => Array.isArray(c) && c[0]?.type?.name === "ActionSheetRowGroup"
											);
											if (groups && groups.length) {
												for (const group of groups) {
													const rows = findInReactTree(
														group,
														(c) => Array.isArray(c) && c.some((ch) => ch?.type?.name === "ActionSheetRow")
													);
													if (rows) { rows.unshift(...buttons); return; }
												}
												if (ActionSheetRow.Group) {
													groups.splice(0, 0, React.createElement(ActionSheetRow.Group, null, ...buttons));
												}
											}
										} catch (e) {
											console.error("[NoDelete] action sheet patch", e);
										}
									});
									patches.push(unpatch);
								}).catch(() => {});
							} catch (e) {
								console.error("[NoDelete] openLazy", e);
							}
						})
					);
				}
			} catch (e) {
				console.error("[NoDelete] context menu setup", e);
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