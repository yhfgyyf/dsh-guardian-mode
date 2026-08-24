window.__ModuleLoader__.load({
	id: "dsh-guardian-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Plain createElement (no JSX) keeps the hand-rolled bundle dependency-free.
		var react = require("react");
		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;

		// ── standalone Remote API (snapshot/watch/requestNow/accept/resume) ───
		var base = (globalThis.location !== undefined && globalThis.location.origin !== "null" && globalThis.location.origin !== "") ? globalThis.location.origin : "";
		function api (path, options) {
			return fetch(base + path, options).then(function (response) {
				if (!response.ok) throw new Error("guardian api " + response.status);
				return response.json();
			});
		}
		function snapshotOf (sessionId) {
			return api("/api/guardian/snapshot?session=" + encodeURIComponent(sessionId), { cache: "no-store" });
		}
		function requestNow (sessionId, final) {
			return api("/api/guardian/request-now", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId, final: final === true })
			});
		}
		function resumeOf (sessionId) {
			return api("/api/guardian/resume", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId })
			});
		}
		function acceptOf (sessionId, auditId) {
			return api("/api/guardian/accept", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId, auditId: auditId })
			});
		}
		function historyOf (sessionId) {
			return api("/api/guardian/history?session=" + encodeURIComponent(sessionId), { cache: "no-store" });
		}

		// ── the dock strip entry (rendered between Todo order 0 and Goal order 10) ─
		var STYLES = {
			root: { boxSizing: "border-box", width: "100%", maxWidth: "var(--dsh-composer-card-max-width, 760px)", margin: "0 auto", paddingBottom: "6px" },
			bar: { boxSizing: "border-box", width: "100%", border: "1px solid var(--dsw-alias-border-l1, #444)", borderRadius: "12px", minHeight: "32px", alignItems: "center", gap: "10px", padding: "4px 5px 4px 12px", display: "flex", fontSize: "13px", lineHeight: "20px" },
			label: { flex: "none", fontWeight: 500 },
			state: { minWidth: 0, flex: 1, color: "var(--dsw-alias-label-secondary, #aaa)", textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" },
			button: { flex: "none", cursor: "pointer", border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary, #aaa)", fontSize: "12px", padding: "2px 6px", borderRadius: "6px" }
		};
		function colorFor (view) {
			if (view.paused) return "var(--dsw-alias-state-error-primary, #e5484d)";
			if (view.lastVerdict === "critical") return "var(--dsw-alias-state-error-primary, #e5484d)";
			if (view.lastVerdict === "warning") return "var(--dsw-alias-state-error-primary, #e5484d)";
			if (view.status === "auditing") return "var(--dsw-alias-state-business-primary, #4c8dff)";
			return "var(--dsw-alias-state-success-primary, #30a46c)";
		}
		function GuardianDock (props) {
			var sessionId = props.sessionId;
			var view = props.view;
			var onAudit = props.onAudit;
			var onResume = props.onResume;
			var onAccept = props.onAccept;
			var [state, setState] = useState(null);
			var [pending, setPending] = useState(false);
			var [failed, setFailed] = useState(null);
			var [history, setHistory] = useState(null);
			useEffect(function () {
				if (sessionId === undefined) return undefined;
				var alive = true;
				setState(null);
				setFailed(null);
				snapshotOf(sessionId).then(function (value) { if (alive) setState(value); }, function (error) { if (alive) setFailed(String(error)); });
				var source = new EventSource(base + "/api/guardian/watch?session=" + encodeURIComponent(sessionId));
				var onEvent = function (event) {
					try {
						var payload = JSON.parse(event.data);
						if (payload.view !== undefined) setState(payload.view);
					} catch (_) { /* partial frame */ }
				};
				source.addEventListener("guardian", onEvent);
				return function () { alive = false; source.close(); };
			}, [sessionId]);
			var current = state ?? view ?? null;
			if (current === null || current.active !== true) return null;
			var color = colorFor(current);
			var approval = current.pendingApproval && current.pendingApproval.status === "pending" ? current.pendingApproval : null;
			var remediation = current.remediation || null;
			var retryable = remediation && ["failed", "execution-failed", "verification-failed"].indexOf(remediation.phase) >= 0;
			var approvalAction = approval || (retryable ? current.pendingApproval : null);
			var remediationIncomplete = remediation && remediation.phase !== "completed";
			var label = remediation && ["queued", "running", "verifying"].indexOf(remediation.phase) >= 0 ? "REPAIR" : current.paused ? "PAUSED" : current.lastVerdict === undefined ? "guardian" : String(current.lastVerdict).toUpperCase();
			var stateText = "step " + current.completedSteps + " · audits " + current.auditCount + " · " + (remediation ? "repair " + remediation.phase : current.paused ? "paused: " + current.pauseReason : approval ? approval.verdict + " review awaiting approval; agent continues" : "failures " + current.failureCount);
			var feedback = current.lastAudit && (current.lastAudit.summary || (current.lastAudit.findings && current.lastAudit.findings[0] && current.lastAudit.findings[0].recommendation));
			var run = function (fn) {
				if (pending) return;
				setPending(true);
				Promise.resolve(fn()).catch(function (error) { setFailed(String(error)); }).finally(function () { setPending(false); });
			};
			return h("div", { style: STYLES.root, "data-guardian-bar": true },
				h("div", { style: Object.assign({}, STYLES.bar, { borderColor: color }) },
					h("span", { style: Object.assign({}, STYLES.label, { color: color }) }, label),
					h("span", { style: STYLES.state, title: feedback || "" }, stateText + (feedback ? " · " + feedback : "") + (failed === null ? "" : " · " + failed)),
					h("button", { style: STYLES.button, disabled: pending, onClick: function () { run(function () { return onAudit ? onAudit() : undefined; }); } }, "audit now"),
					h("button", { style: STYLES.button, disabled: pending, onClick: function () { run(function () { return historyOf(sessionId).then(function (value) { setHistory(history === null ? value.entries : null); }); }); } }, history === null ? "history" : "hide"),
					approvalAction ? h("button", { style: STYLES.button, disabled: pending, onClick: function () { run(function () { return onAccept ? onAccept(approvalAction.auditId) : undefined; }); } }, retryable ? "retry repair" : "accept repair") : null,
					current.paused && !remediationIncomplete && !(approval && approval.verdict === "critical") ? h("button", { style: STYLES.button, disabled: pending, onClick: function () { run(function () { return onResume ? onResume() : undefined; }); } }, "resume") : null
				),
				history === null ? null : h("pre", { style: { margin: "4px 8px 0", whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-secondary, #aaa)", fontSize: "11px" } }, history.slice(-10).map(function (entry) { return "#" + entry.sequence + " " + (entry.errorCode || entry.verdict) + " · " + (entry.summary || ""); }).join("\n"))
			);
		}

		/**
		 * Client plugin body: the guardian dock footer between Todo (order 0)
		 * and Goal (order 10) at order 5, over its own Remote API.
		 */
		var NS = "guardian";
		function apply (ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { en: {}, zh: {} });
			}, "ui-guardian: dictionaries");
			ctx.slots.inject("conversation.input.dock", function () {
				return ctx.slots.register({
					name: "conversation.input.dock",
					id: "guardian",
					order: 5,
					locale: NS,
					inject: function (sessionId) {
						return {
							sessionId: String(sessionId),
							view: undefined,
							onAudit: function () { return requestNow(String(sessionId), false); },
							onAccept: function (auditId) { return acceptOf(String(sessionId), auditId); },
							onResume: function () { return resumeOf(String(sessionId)); }
						};
					}
				}, GuardianDock);
			});
		}
		exports.GuardianDock = GuardianDock;
		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		exports.GUARDIAN_DOCK_ORDER = 5;
		return module.exports;
	}
});
