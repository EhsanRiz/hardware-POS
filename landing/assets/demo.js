/* InnovaPOS — live product search on the landing page.
 *
 * Not a mockup. It runs the same normalisation and matching rules as
 * src/lib/search.ts in the till, and as pos_search_products in migrations
 * 0010–0011. Anyone can check the claim by typing into it, which is the point:
 * a demo that fakes its results is worth less than no demo.
 *
 * Keep in step with src/lib/search.ts. If the rules change there, change them
 * here, or this page starts advertising behaviour the product no longer has.
 */
(function () {
  "use strict";

  var THIN = " "; // U+2009 THIN SPACE — the SA thousands separator
  var VAT_RATE = 0.15;

  /* The catalogue mirrors the handoff's reference rows, so the till on this
     page shows the same four lines as the design document. */
  var CATALOGUE = [
    { sku: "601240", name: "Cement, 42.5N — 50 kg bag", barcode: "6001240000015",
      unit: "bag", price: 120.90, kind: "plain", meta: "601240 · stock 148 → 128", qty: 20 },
    { sku: "704410", name: "Rebar Y12 — cut to 2.4 m", barcode: null,
      unit: "ea", price: 94.70, kind: "cut", meta: "7.2 m from 6 m stock · offcut 0.4 m", qty: 3 },
    { sku: "550120", name: "Galvanised wire, 2.0 mm — loose", barcode: null,
      unit: "kg", price: 31.05, kind: "weighed", meta: "scale 02 · tare 0.35 kg", qty: 6.40 },
    { sku: "880310", name: "Sikaflex 11FC — 300 ml", barcode: "6008803000101",
      unit: "ea", price: 119.00, kind: "fresh", meta: "just scanned · stock 41 → 40", qty: 1 },
    { sku: "NCN-2550", name: "Nail Concrete 2.5 × 50 mm", barcode: null,
      unit: "kg", price: 68.00, kind: "plain", meta: "NCN-2550 · stock 40 → 39", qty: 1 },
    { sku: "NCN-3060", name: "Nail Concrete 3.0 × 60 mm", barcode: null,
      unit: "kg", price: 72.00, kind: "plain", meta: "NCN-3060 · stock 35 → 34", qty: 1 },
    { sku: "NWR-2550", name: "Nail Wire Round 2.5 × 50 mm", barcode: null,
      unit: "kg", price: 42.00, kind: "plain", meta: "NWR-2550 · stock 85 → 84", qty: 1 },
    { sku: "CHN-06", name: "Chain 6 mm Galvanised", barcode: null,
      unit: "m", price: 35.00, kind: "cut", meta: "2.5 m from 30 m coil", qty: 2.5 },
    { sku: "ANC-M10", name: "Anchor Bolt Sleeve M10 × 100 mm", barcode: null,
      unit: "ea", price: 18.50, kind: "plain", meta: "ANC-M10 · stock 200 → 199", qty: 1 }
  ];

  /* ---- The one number formatter, matching src/lib/money.ts --------------- */
  function group(intPart) {
    var out = "";
    for (var i = 0; i < intPart.length; i++) {
      if (i > 0 && i % 3 === 0) out = THIN + out;
      out = intPart[intPart.length - 1 - i] + out;
    }
    return out;
  }
  function money(v, withR) {
    var fixed = Math.abs(v).toFixed(2).split(".");
    var s = group(fixed[0]) + "." + fixed[1];
    return withR ? "R" + THIN + s : s;
  }
  function qty(v, unit, weighed) {
    var n = weighed ? v.toFixed(2) : String(Number(v.toFixed(3)));
    return unit && unit !== "ea" ? n + " " + unit : n;
  }

  /* ---- Search, mirroring normalize_search_text() ------------------------- */
  function normalize(t) {
    return (t || "").toLowerCase()
      .replace(/(\d),(\d)/g, "$1.$2")
      .replace(/(\d)\s*[x*×]\s*(\d)/g, "$1 x $2")
      .replace(/(\d)(mm|cm|m|kg|g|l|ml)\b/g, "$1 $2")
      .replace(/[^a-z0-9. ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function textFor(p) {
    return normalize(p.name + " " + p.sku + " " + (p.barcode || ""));
  }
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i], best = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function search(query) {
    var n = normalize(query);
    if (!n) return CATALOGUE.slice(0, 4);
    var toks = n.split(" ").filter(function (t) { return t && t !== "x"; });
    if (!toks.length) return CATALOGUE.slice(0, 4);

    // Pass 1: every word must be accounted for.
    var hits = CATALOGUE.filter(function (p) {
      var t = textFor(p);
      return toks.every(function (tok) { return t.indexOf(tok) !== -1; });
    });

    // Pass 2: edit distance, only when the precise pass found nothing.
    if (!hits.length) {
      hits = CATALOGUE.filter(function (p) {
        var words = textFor(p).split(" ").filter(Boolean);
        return toks.every(function (tok) {
          var tol = tok.length < 4 ? 1 : 2;
          return words.some(function (w) { return editDistance(tok, w, tol) <= tol; });
        });
      });
    }
    return hits.sort(function (a, b) { return a.name.length - b.name.length; }).slice(0, 4);
  }

  /* ---- Render ------------------------------------------------------------ */
  var input = document.getElementById("demo-q");
  var list = document.getElementById("demo-results");
  if (!input || !list) return;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    var rows = search(input.value);
    list.innerHTML = "";

    if (!rows.length) {
      var none = el("div", "line");
      none.style.gridTemplateColumns = "1fr";
      none.appendChild(el("div", "meta", "Nothing matches “" + input.value + "”."));
      list.appendChild(none);
      setTotals([]);
      return;
    }

    rows.forEach(function (p, i) {
      var row = el("div", "line" + (p.kind === "fresh" ? " fresh" : ""));
      row.appendChild(el("span", "n", String(i + 1)));

      var item = el("div");
      item.appendChild(el("div", "desc", p.name));
      var meta = el("div", "meta");
      // Cut and weighed lines carry a tag before their metadata, because these
      // are the lines a customer queries later.
      if (p.kind === "cut" || p.kind === "weighed") {
        meta.appendChild(el("span", "tag", p.kind === "cut" ? "Cut" : "Weighed"));
      }
      meta.appendChild(document.createTextNode(p.meta));
      item.appendChild(meta);
      row.appendChild(item);

      row.appendChild(el("span", "qty", qty(p.qty, p.unit, p.kind === "weighed")));
      row.appendChild(el("span", "amt", money(p.price * p.qty, false)));
      list.appendChild(row);
    });

    setTotals(rows);
  }

  function setTotals(rows) {
    var total = rows.reduce(function (s, p) {
      return s + Math.round(p.price * p.qty * 100) / 100;
    }, 0);
    total = Math.round(total * 100) / 100;
    var units = rows.reduce(function (s, p) { return s + p.qty; }, 0);
    var vat = Math.round((total - total / (1 + VAT_RATE)) * 100) / 100;
    var ex = Math.round((total - vat) * 100) / 100;

    document.getElementById("line-count").textContent =
      rows.length + (rows.length === 1 ? " line · " : " lines · ") +
      Number(units.toFixed(2)) + " units";
    document.getElementById("sub-fig").textContent = money(ex, false);
    document.getElementById("vat-fig").textContent = money(vat, false);
    document.getElementById("total-fig").textContent = money(total, true);
  }

  input.addEventListener("input", render);

  Array.prototype.forEach.call(document.querySelectorAll("[data-try]"), function (btn) {
    btn.addEventListener("click", function () {
      input.value = btn.getAttribute("data-try");
      input.focus();
      render();
    });
  });

  // F2 opens search, as the till does.
  document.addEventListener("keydown", function (e) {
    if (e.key === "F2") { e.preventDefault(); input.focus(); input.select(); }
  });

  render();

  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () { header.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();
