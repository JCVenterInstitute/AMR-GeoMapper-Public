export class TooltipManager {
  constructor(host) {
    this.host = host;
    this._tooltipAbort = null;
    this._openTip = null;
  }

  setupTooltips({ hoverDelay = 1000, focusDelay = 0 } = {}) {
    const root = this.host.shadow;
    const hasPopover = "showPopover" in HTMLElement.prototype;

    if (this._tooltipAbort) this._tooltipAbort.abort();
    this._tooltipAbort = new AbortController();

    if (this._openTip && hasPopover && this._openTip.isConnected) {
      try {
        this._openTip.hidePopover();
      } catch {
        // hidePopover throws if popover is not currently shown - this is expected
      }
    }
    this._openTip = null;

    root.querySelectorAll(".mgo-tooltip").forEach((el) => el.remove());

    // Fallback for old browsers
    let portal, portalText;
    const bodyPortalShow = (btn, text) => {
      if (!portal) {
        portal = document.createElement("div");
        portalText = document.createElement("div");
        Object.assign(portal.style, {
          position: "fixed",
          zIndex: "2147483647",
          pointerEvents: "none",
        });
        Object.assign(portalText.style, {
          background: "#111",
          color: "#fff",
          padding: "6px 8px",
          borderRadius: "8px",
          boxShadow: "0 8px 24px rgba(0,0,0,.25)",
          font: "12px/1.25 system-ui, sans-serif",
          margin: 0,
        });
        portal.appendChild(portalText);
        document.body.appendChild(portal);
      }
      portalText.textContent = text;
      const r = btn.getBoundingClientRect();
      const x = Math.min(
        Math.max(r.left + r.width / 2, 8),
        window.innerWidth - 8,
      );
      const y = Math.max(r.bottom + 4, 8);
      portal.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
      portal.style.display = "block";
      window.addEventListener("scroll", bodyPortalHide, {
        once: true,
        signal: this._tooltipAbort.signal,
      });
    };
    const bodyPortalHide = () => {
      if (portal) portal.style.display = "none";
    };

    root.querySelectorAll("[data-tooltip]").forEach((btn, i) => {
      const tip = document.createElement("div");
      tip.className = "mgo-tooltip";
      tip.setAttribute("popover", "manual");
      tip.textContent = btn.getAttribute("data-tooltip");
      const place = btn.getAttribute("data-placement");
      if (place) tip.dataset.placement = place;

      btn.style.anchorName = `--btn-anchor-${i}`;
      tip.style.positionAnchor = `--btn-anchor-${i}`;

      root.appendChild(tip);

      const connected = () =>
        btn.isConnected && tip.isConnected && root.isConnected;
      const show = () => {
        if (!connected()) return;

        if (this._openTip && this._openTip !== tip) {
          try {
            hasPopover ? this._openTip.hidePopover() : bodyPortalHide();
          } catch {
            // hidePopover throws if popover is not currently shown - this is expected
          }
        }

        if (hasPopover) {
          void tip.offsetWidth;
          tip.showPopover();
        } else {
          bodyPortalShow(btn, tip.textContent);
        }
        this._openTip = tip;
      };
      const hide = () => {
        if (this._openTip === tip) {
          if (hasPopover && tip.isConnected) {
            try {
              tip.hidePopover();
            } catch {
              // hidePopover throws if popover is not currently shown - this is expected
            }
          } else {
            bodyPortalHide();
          }
          this._openTip = null;
        }
      };

      let hoverTimer = null;

      const scheduleShow = (delay) => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(show, delay);
      };
      const cancelShow = () => {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      };

      btn.addEventListener("mouseenter", () => scheduleShow(hoverDelay), {
        signal: this._tooltipAbort.signal,
      });
      btn.addEventListener(
        "mouseleave",
        () => {
          cancelShow();
          setTimeout(() => hide(), 120);
        },
        { signal: this._tooltipAbort.signal },
      );

      btn.addEventListener("focusin", () => scheduleShow(focusDelay), {
        signal: this._tooltipAbort.signal,
      });
      btn.addEventListener(
        "focusout",
        () => {
          cancelShow();
          hide();
        },
        { signal: this._tooltipAbort.signal },
      );

      btn.addEventListener(
        "pointerdown",
        () => {
          cancelShow();
          hide();
        },
        { signal: this._tooltipAbort.signal },
      );
    });
  }

  destroy() {
    this._tooltipAbort?.abort();
    this._tooltipAbort = null;
    this._openTip = null;
  }
}
