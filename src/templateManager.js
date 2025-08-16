import Template from "./Template";
import { base64ToUint8, numberToEncoded, colorpalette } from "./utils";

/** Manages the template system.
 * This class handles all external requests for template modification, creation, and analysis.
 * It serves as the central coordinator between template instances and the user interface.
 * @class TemplateManager
 * @since 0.55.8
 * @example
 * // JSON structure for a template
 * {
 *   "whoami": "BlueMarble",
 *   "scriptVersion": "1.13.0",
 *   "schemaVersion": "2.1.0",
 *   "templates": {
 *     "0 $Z": {
 *       "name": "My Template",
 *       "enabled": true,
 *       "tiles": {
 *         "1231,0047,183,593": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "1231,0048,183,000": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     },
 *     "1 $Z": {
 *       "name": "My Template",
 *       "URL": "https://github.com/SwingTheVine/Wplace-BlueMarble/blob/main/dist/assets/Favicon.png",
 *       "URLType": "template",
 *       "enabled": false,
 *       "tiles": {
 *         "375,1846,276,188": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "376,1846,000,188": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     }
 *   }
 * }
 */
export default class TemplateManager {

  /** The constructor for the {@link TemplateManager} class.
   * @since 0.55.8
   */
  constructor(name, version, overlay) {

    // Meta
    this.name = name; // Name of userscript
    this.version = version; // Version of userscript
    this.overlay = overlay; // The main instance of the Overlay class
    this.templatesVersion = '1.0.0'; // Version of JSON schema
    this.userID = null; // The ID of the current user
    this.encodingBase = '!#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~'; // Characters to use for encoding/decoding
    this.tileSize = 1000; // The number of pixels in a tile. Assumes the tile is square
    this.drawMult = 3; // The enlarged size for each pixel. E.g. when "3", a 1x1 pixel becomes a 1x1 pixel inside a 3x3 area. MUST BE ODD
    
    // Template
    this.canvasTemplate = null; // Our canvas
    this.canvasTemplateZoomed = null; // The template when zoomed out
    this.canvasTemplateID = 'bm-canvas'; // Our canvas ID
    this.canvasMainID = 'div#map canvas.maplibregl-canvas'; // The selector for the main canvas
    this.template = null; // The template image.
    this.templateState = ''; // The state of the template ('blob', 'proccessing', 'template', etc.)
    this.templatesArray = []; // All Template instnaces currently loaded (Template)
    this.templatesJSON = null; // All templates currently loaded (JSON)
    this.templatesShouldBeDrawn = true; // Should ALL templates be drawn to the canvas?
    this.statusLastUpdate = 0; // Timestamp for last status UI update (ms)
    this.statusUpdateIntervalMs = 500; // Throttle interval for status updates
    this.debug = false; // Verbose logging toggle
    this.autoColorLive = true; // Live toggle for auto-colored preview
    this.mergedTileCache = new Map(); // Cache of merged tile images for quick re-renders
    this.cacheVersion = 0; // Bump to invalidate cache when templates change
    this.maxTemplates = 10; // Maximum number of templates supported
    this.lastSelectedPaletteIndex = null; // Track last auto-selected palette index to avoid redundant actions

    // Zoom behavior
    this.zoomLevel = null; // Latest known zoom level (if provided by site events)
    // Lower threshold so "zoomed-in" (small squares) mode activates at normal zoom levels.
    // We compute z = log2(scale). At scale=1 => z=0 (zoomed out). Around scale≈2 (z≈1) we want squares mode.
    // Therefore, consider zoomed-out only when z <= 0.75 (~scale <= 1.68).
    this.zoomOutThreshold = 0.75; // <= shows full image with reduced opacity; > shows opaque small squares
    // Force full opacity even in zoomed-out mode to avoid pinkish look from blending
    this.zoomOpacity = 0.4; // Opacity to use when zoomed-out (small-squares preview)
    this.isZoomedOut = true; // Derived state

    // Bind handlers and attach listeners early so we can react to zoom state
    this.onZoom = (e) => { this.#updateZoomState(e); };
    this.onMove = () => { this.#updateZoomState(); };
    this.onResize = () => { this.#updateZoomState(); };
    try {
      window.addEventListener('zoom', this.onZoom);
      window.addEventListener('move', this.onMove);
      window.addEventListener('resize', this.onResize);
    } catch (_) { /* ignore if environment lacks these events */ }
  }

  /** Retrieves the pixel art canvas.
   * If the canvas has been updated/replaced, it retrieves the new one.
   * @param {string} selector - The CSS selector to use to find the canvas.
   * @returns {HTMLCanvasElement|null} The canvas as an HTML Canvas Element, or null if the canvas does not exist
   * @since 0.58.3
   * @deprecated Not in use since 0.63.25
   */
  /* @__PURE__ */getCanvas() {

    // If the stored canvas is "fresh", return the stored canvas
    if (document.body.contains(this.canvasTemplate)) {return this.canvasTemplate;}
    // Else, the stored canvas is "stale", get the canvas again

    // Attempt to find and destroy the "stale" canvas
    document.getElementById(this.canvasTemplateID)?.remove(); 

    const canvasMain = document.querySelector(this.canvasMainID);

    const canvasTemplateNew = document.createElement('canvas');
    canvasTemplateNew.id = this.canvasTemplateID;
    canvasTemplateNew.className = 'maplibregl-canvas';
    canvasTemplateNew.style.position = 'absolute';
    canvasTemplateNew.style.top = '0';
    canvasTemplateNew.style.left = '0';
    canvasTemplateNew.style.height = `${canvasMain?.clientHeight * (window.devicePixelRatio || 1)}px`;
    canvasTemplateNew.style.width = `${canvasMain?.clientWidth * (window.devicePixelRatio || 1)}px`;
    canvasTemplateNew.height = canvasMain?.clientHeight * (window.devicePixelRatio || 1);
    canvasTemplateNew.width = canvasMain?.clientWidth * (window.devicePixelRatio || 1);
    canvasTemplateNew.style.zIndex = '8999';
    canvasTemplateNew.style.pointerEvents = 'none';
    canvasMain?.parentElement?.appendChild(canvasTemplateNew); // Append the newCanvas as a child of the parent of the main canvas
    this.canvasTemplate = canvasTemplateNew; // Store the new canvas

    window.addEventListener('move', this.onMove);
    window.addEventListener('zoom', this.onZoom);
    window.addEventListener('resize', this.onResize);

    return this.canvasTemplate; // Return the new canvas
  }

  /** Creates the JSON object to store templates in
   * @returns {{ whoami: string, scriptVersion: string, schemaVersion: string, templates: Object }} The JSON object
   * @since 0.65.4
   */
  async createJSON() {
    return {
      "whoami": this.name.replace(' ', ''), // Name of userscript without spaces
      "scriptVersion": this.version, // Version of userscript
      "schemaVersion": this.templatesVersion, // Version of JSON schema
      "templates": {} // The templates
    };
  }

  /** Creates the template from the inputed file blob
   * @param {File} blob - The file blob to create a template from
   * @param {string} name - The display name of the template
   * @param {Array<number, number, number, number>} coords - The coordinates of the top left corner of the template
   * @param {boolean} [autoColor=false] - When true, map colors to nearest palette during processing
   * @since 0.65.77
   */
  async createTemplate(blob, name, coords, autoColor = false) {

    // Creates the JSON object if it does not already exist
    if (!this.templatesJSON) {this.templatesJSON = await this.createJSON(); console.log(`Creating JSON...`);}

    this.overlay.handleDisplayStatus(`Creating template at ${coords.join(', ')}...`);

    // Enforce maximum template count
    if (this.templatesArray.length >= this.maxTemplates) {
      this.overlay?.handleDisplayError?.(`You can have up to ${this.maxTemplates} templates. Remove one to add another.`);
      return;
    }

    // Compute a unique sortID (lowest available non-negative integer)
    const usedSortIDs = new Set(this.templatesArray.map(t => t.sortID));
    let nextSortID = 0; while (usedSortIDs.has(nextSortID)) { nextSortID++; }

    // Creates a new template instance
    const template = new Template({
      displayName: name,
      sortID: nextSortID,
      authorID: numberToEncoded(this.userID || 0, this.encodingBase),
      file: blob,
      coords: coords,
      autoColor: autoColor,
      enabled: true
    });
    // Compose unique key used in JSON (sortID + authorID)
    template.idKey = `${template.sortID} ${template.authorID}`;
    //template.chunked = await template.createTemplateTiles(this.tileSize); // Chunks the tiles
    const { templateTiles, templateTilesAuto, templateTilesFull, templateTilesAutoFull, templateTilesBuffers } = await template.createTemplateTiles(this.tileSize); // Chunks the tiles
    // Store both versions for instant swapping without reprocessing
    template.chunkedOriginal = templateTiles;
    template.chunkedAuto = templateTilesAuto;
    template.chunkedOriginalFull = templateTilesFull; // Non-masked (solid) variants
    template.chunkedAutoFull = templateTilesAutoFull; // Non-masked (solid) variants
    // Default active set honors live toggle first, falling back to creation-time autoColor
    template.chunked = (this.autoColorLive || autoColor) ? (template.chunkedAuto || templateTiles) : (template.chunkedOriginal || templateTiles);

    // Appends/updates a child into the templates object
    // The child's name is the number of templates already in the list (sort order) plus the encoded player ID
    this.templatesJSON.templates[template.idKey] = {
      "name": template.displayName, // Display name of template
      "coords": coords.join(', '), // The coords of the template
      "enabled": true,
      "tiles": templateTilesBuffers // Stores the chunked tile buffers
    };

    this.templatesArray.push(template); // Pushes the Template object instance to the Template Array

    // ==================== PIXEL COUNT DISPLAY SYSTEM ====================
    // Display pixel count statistics with internationalized number formatting
    // This provides immediate feedback to users about template complexity and size
    const pixelCountFormatted = new Intl.NumberFormat().format(template.pixelCount);
    this.overlay.handleDisplayStatus(`Template created at ${coords.join(', ')}! Total pixels: ${pixelCountFormatted}`);

    console.log(Object.keys(this.templatesJSON.templates).length);
    console.log(this.templatesJSON);
    console.log(this.templatesArray);
    console.log(JSON.stringify(this.templatesJSON));

    // Invalidate merged tile cache because template set changed
    this.cacheVersion++;
    this.mergedTileCache.clear();

    await this.#storeTemplates();
  }

  /** Generates a {@link Template} class instance from the JSON object template
   */
  #loadTemplate() {

  }

  /** Stores the JSON object of the loaded templates into TamperMonkey (GreaseMonkey) storage.
   * @since 0.72.7
   */
  async #storeTemplates() {
    // Ensure the write completes before proceeding (prevents data loss on fast reloads)
    await GM.setValue('bmTemplates', JSON.stringify(this.templatesJSON));
  }

  /** Deletes a template from the JSON object.
   * Also delete's the corrosponding {@link Template} class instance
   */
  deleteTemplate() {

  }

  /** Disables the template from view
   */
  async disableTemplate() {

    // Creates the JSON object if it does not already exist
    if (!this.templatesJSON) {this.templatesJSON = await this.createJSON(); console.log(`Creating JSON...`);}


  }

  /** Draws all templates on the specified tile.
   * This method handles the rendering of template overlays on individual tiles.
   * @param {File} tileBlob - The pixels that are placed on a tile
   * @param {Array<number>} tileCoords - The tile coordinates [x, y]
   * @since 0.65.77
   */
  async drawTemplateOnTile(tileBlob, tileCoords) {

    // Returns early if no templates should be drawn
    if (!this.templatesShouldBeDrawn) {return tileBlob;}

    const drawSize = this.tileSize * this.drawMult; // Calculate draw multiplier for scaling

    // Format tile coordinates with proper padding for consistent lookup
    tileCoords = tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0');

    // Fast path: nothing to draw if there are no templates at all
    if (!this.templatesArray || this.templatesArray.length === 0) {return tileBlob;}

    // Update zoom state best-effort (in case no events were received yet)
    this.#updateZoomState();

    // Check cache for merged output of this tile and mode (auto/original) and zoom mode (full/mask)
    const zoomKey = this.isZoomedOut ? 'full' : 'mask';
    const cacheKey = `${tileCoords}|${this.autoColorLive ? 'auto' : 'orig'}|${zoomKey}|v${this.cacheVersion}`;
    const cached = this.mergedTileCache.get(cacheKey);
    if (cached) { return cached; }

    if (this.debug) {console.log(`Searching for templates in tile: "${tileCoords}"`);}    

    const templateArray = this.templatesArray.filter(t => t?.enabled); // Only enabled templates
    if (this.debug) {console.log(templateArray);}    

    // Sorts the array of Template class instances. 0 = first = lowest draw priority
    templateArray.sort((a, b) => {return a.sortID - b.sortID;});

    console.log(templateArray);

    // Retrieves the relavent template tile blobs
    const templatesToDraw = templateArray
      .map(template => {
        const matchingTiles = Object.keys(template.chunked).filter(tile =>
          tile.startsWith(tileCoords)
        );

        if (matchingTiles.length === 0) {return null;} // Return null when nothing is found

        // Retrieves the blobs of the templates for this tile
        const matchingTileBlobs = matchingTiles.map(tile => {

          const coords = tile.split(','); // [x, y, x, y] Tile/pixel coordinates
          
          // Choose which bitmap set to draw from based on live toggle and zoom mode
          const sourceMap = this.autoColorLive
            ? (template.chunkedAuto || template.chunked)
            : (template.chunkedOriginal || template.chunked);
          const sourceMapFull = this.autoColorLive
            ? (template.chunkedAutoFull || sourceMap)
            : (template.chunkedOriginalFull || sourceMap);

          // Use the masked 3x3 scaled bitmap so the template appears as small squares.
          // Opacity is still controlled by zoom mode (e.g., 40% when zoomed-out, 100% when zoomed-in).
          return {
            bitmap: sourceMap[tile],
            tileCoords: [coords[0], coords[1]],
            pixelCoords: [coords[2], coords[3]]
          }
        });

        return matchingTileBlobs?.[0];
      })
    .filter(Boolean);

    if (this.debug) {console.log(templatesToDraw);}    
    // If there are no matching overlays for this tile, return original blob immediately
    if (!templatesToDraw || templatesToDraw.length === 0) { return tileBlob; }
    // Throttle expensive status updates to avoid UI bottlenecks
    const now = Date.now();
    if (now - this.statusLastUpdate >= this.statusUpdateIntervalMs) {
      const templateCount = templatesToDraw?.length || 0; // Number of templates to draw on this tile
      if (this.debug) {console.log(`templateCount = ${templateCount}`);}      
      if (templateCount > 0) {
        // Calculate total pixel count for templates actively being displayed in this tile
        const totalPixels = templateArray
          .filter(template => Object.keys(template.chunked).some(tile => tile.startsWith(tileCoords)))
          .reduce((sum, template) => sum + (template.pixelCount || 0), 0);
        const pixelCountFormatted = new Intl.NumberFormat().format(totalPixels);
        this.overlay.handleDisplayStatus(
          `Displaying ${templateCount} template${templateCount == 1 ? '' : 's'}.\nTotal pixels: ${pixelCountFormatted}`
        );
      } else {
        this.overlay.handleDisplayStatus(`Displaying ${templateCount} templates.`);
      }
      this.statusLastUpdate = now;
    }
    
    const tileBitmap = await createImageBitmap(tileBlob);

    const canvas = new OffscreenCanvas(drawSize, drawSize);
    const context = canvas.getContext('2d');

    context.imageSmoothingEnabled = false; // Nearest neighbor

    // Tells the canvas to ignore anything outside of this area
    context.beginPath();
    context.rect(0, 0, drawSize, drawSize);
    context.clip();

    context.clearRect(0, 0, drawSize, drawSize); // Draws transparent background
    context.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

    // Determine zoom state robustly per-frame (fallback to CSS scale if no events)
    const sEff = this.#getCanvasScale();
    const zEff = (typeof sEff === 'number') ? Math.log2(Math.max(1e-6, sEff)) : this.zoomLevel;
    const localIsZoomedOut = (typeof zEff === 'number' && !Number.isNaN(zEff)) ? (zEff <= this.zoomOutThreshold) : this.isZoomedOut;

    // For each template in this tile, draw them.
    for (const template of templatesToDraw) {
      if (this.debug) {console.log(`Template:`); console.log(template);}      

      // Draw the template on the tile based on its relative position
      if (localIsZoomedOut) {
        context.save();
        context.globalAlpha = this.zoomOpacity; // 40% opacity in zoomed-out mode
        context.drawImage(template.bitmap, Number(template.pixelCoords[0]) * this.drawMult, Number(template.pixelCoords[1]) * this.drawMult);
        context.restore();
      } else {
        // Force full opacity when drawing small squares (zoomed-in mode)
        context.save();
        context.globalAlpha = 1; // ensure 100% opacity in small-squares mode
        context.drawImage(template.bitmap, Number(template.pixelCoords[0]) * this.drawMult, Number(template.pixelCoords[1]) * this.drawMult);
        context.restore();
      }
    }

    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    // Store in cache for instant reuse when revisiting the same tile/zoom
    this.mergedTileCache.set(cacheKey, outBlob);
    return outBlob;
  }

  /** Update internal zoom state using event details or computed canvas transform */
  #updateZoomState(event) {
    try {
      let z = this.zoomLevel;
      const d = event?.detail || {};
      if (typeof d.zoom === 'number') { z = d.zoom; }
      else if (typeof d.level === 'number') { z = d.level; }
      else if (typeof d.scale === 'number') { z = Math.log2(d.scale); }
      // Fallback: compute from canvas CSS transform scale
      if (z == null || Number.isNaN(z)) {
        const s = this.#getCanvasScale();
        if (s != null) {
          // Map CSS scale to a pseudo-zoom; higher scale => more zoomed-in
          z = Math.log2(Math.max(1e-6, s));
        }
      }
      const prev = this.isZoomedOut;
      if (typeof z === 'number' && !Number.isNaN(z)) {
        this.zoomLevel = z;
        this.isZoomedOut = (z <= this.zoomOutThreshold);
      } else {
        // If unknown, keep prior or use conservative default
        this.isZoomedOut = this.isZoomedOut || false;
      }
      if (prev !== this.isZoomedOut) {
        // Zoom mode changed: invalidate cache so tiles redraw with/without opacity/full
        this.cacheVersion++;
        this.mergedTileCache.clear();
      }
    } catch (_) { /* ignore */ }
  }

  /** Compute approximate CSS transform scale of the main canvas (best-effort) */
  #getCanvasScale() {
    try {
      const canvasMain = document.querySelector(this.canvasMainID);
      if (!canvasMain) return null;
      const tr = getComputedStyle(canvasMain).transform;
      if (!tr || tr === 'none') return 1;
      // matrix(a, b, c, d, tx, ty)
      const m = tr.match(/matrix\(([-0-9eE\.]+),\s*([-0-9eE\.]+),\s*([-0-9eE\.]+),\s*([-0-9eE\.]+),/);
      if (!m) return 1;
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      const c = parseFloat(m[3]);
      const d = parseFloat(m[4]);
      const scaleX = Math.sqrt(a*a + b*b) || 1;
      const scaleY = Math.sqrt(c*c + d*d) || 1;
      return Math.max(scaleX, scaleY);
    } catch (_) { return null; }
  }

  /** Sets the live auto-color toggle
   * @param {boolean} value
   */
  setAutoColorLive(value) {
    this.autoColorLive = !!value;
  }

  /** Attempt to auto-select the site's paint color based on the topmost enabled template
   * at the given tile/pixel coordinates when live auto-color is enabled.
   * Safe no-op if prerequisites are not met.
   * @param {[number, number]} tileCoords - [tileX, tileY]
   * @param {[number, number]} pixelCoords - [pxX, pxY] within the tile (0-999)
   */
  maybeAutoSelectColor(tileCoords, pixelCoords) {
    try {
      if (!this.autoColorLive) {
        if (this.debug) console.debug('[BM] AutoColor: live toggle OFF; skipping');
        return;
      }
      if (!Array.isArray(tileCoords) || !Array.isArray(pixelCoords)) { return; }
      if (tileCoords.length < 2 || pixelCoords.length < 2) { return; }
      if (!this.templatesArray || this.templatesArray.length === 0) { return; }

      const colorIndex = this.#getNearestPaletteIndexAt(tileCoords, pixelCoords);
      if (this.debug) console.debug('[BM] AutoColor: lookup', { tileCoords, pixelCoords, colorIndex });
      if (colorIndex > 0) {
        // Avoid excessive reselect attempts if index hasn't changed
        if (this.lastSelectedPaletteIndex !== colorIndex) {
          this.#selectSitePaletteColor(colorIndex);
          this.lastSelectedPaletteIndex = colorIndex;
        } else if (this.debug) {
          console.debug('[BM] AutoColor: palette index unchanged; not reselecting', colorIndex);
        }
      }
    } catch (e) { if (this.debug) { console.warn('[BM] maybeAutoSelectColor failed:', e); } }
  }

  /** Compute the nearest palette index for the topmost enabled template at a given
   * absolute tile/pixel coordinate. Returns 0 if none found (transparent/none).
   * @param {[number, number]} tileCoords - [tileX, tileY]
   * @param {[number, number]} pixelCoords - [pxX, pxY]
   * @returns {number}
   */
  #getNearestPaletteIndexAt(tileCoords, pixelCoords) {
    // Respect current render order: enabled templates sorted by sortID (lowest draws first, highest on top)
    const enabled = (this.templatesArray || []).filter(t => t?.enabled);
    enabled.sort((a, b) => a.sortID - b.sortID);

    const tilePrefix = `${tileCoords[0].toString().padStart(4, '0')},${tileCoords[1].toString().padStart(4, '0')},`;
    const pxX = Number(pixelCoords[0]);
    const pxY = Number(pixelCoords[1]);

    // Iterate from topmost (highest sortID) to lowest so we pick the visible pixel
    for (let i = enabled.length - 1; i >= 0; i--) {
      const tpl = enabled[i];
      // Ensure colorIndexTiles container exists for lazy computation
      if (!tpl.colorIndexTiles) tpl.colorIndexTiles = {};
      const idxTiles = tpl.colorIndexTiles;

      // Find the tile region within this template that covers the given pixel
      // Keys look like: "TTTT,TTTT,PPP,PPP" where the last two are the region's top-left px offset within the tile
      const keys = Object.keys(idxTiles).filter(k => k.startsWith(tilePrefix));
      // If no precomputed keys found, attempt to compute from bitmaps for this tile prefix
      if (keys.length === 0 && tpl?.chunked) {
        for (const key of Object.keys(tpl.chunked)) {
          if (key.startsWith(tilePrefix)) {
            // Lazily compute and cache index map for this tile region
            this.#ensureIndexMapForTemplateTile(tpl, key);
          }
        }
      }
      const keys2 = Object.keys(idxTiles).filter(k => k.startsWith(tilePrefix));
      const searchKeys = keys2.length ? keys2 : keys; // Prefer updated list
      for (const key of searchKeys) {
        const parts = key.split(',');
        const startX = Number(parts[2]);
        const startY = Number(parts[3]);
        const { w, h, data } = idxTiles[key] || {};
        if (!w || !h || !data) { continue; }
        const localX = pxX - startX;
        const localY = pxY - startY;
        if (localX >= 0 && localY >= 0 && localX < w && localY < h) {
          const idx = data[localY * w + localX] || 0;
          if (idx > 0) { return idx; }
        }
      }
    }
    return 0;
  }

  /** Lazily compute nearest-palette index map for a template tile bitmap when not precomputed (e.g., imported JSON)
   * Stores result in tpl.colorIndexTiles[key] = { w, h, data }
   * @param {Template} tpl
   * @param {string} key - "TTTT,TTTT,PPP,PPP"
   */
  #ensureIndexMapForTemplateTile(tpl, key) {
    try {
      if (!tpl || !key) return;
      if (!tpl.colorIndexTiles) tpl.colorIndexTiles = {};
      if (tpl.colorIndexTiles[key]) return; // already computed
      const bmp = tpl?.chunked?.[key];
      if (!bmp || !bmp.width || !bmp.height) return;

      const drawMult = Math.max(1, Number(this.drawMult) || 1);
      const w = Math.max(1, Math.round(bmp.width / drawMult));
      const h = Math.max(1, Math.round(bmp.height / drawMult));
      const mid = Math.floor(drawMult / 2);

      // Create a canvas to read pixels from the bitmap
      const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(bmp.width, bmp.height) : document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, bmp.width, bmp.height);
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const data = img.data;
      const idxMap = new Uint16Array(w * h);

      // Local nearest-palette index using colorpalette
      const nearestIdx = (r, g, b) => {
        let bestI = 1; // default to 1 (Black) if unknown
        let bestD = Infinity;
        for (let i = 0; i < colorpalette.length; i++) {
          const c = colorpalette[i];
          if (!c || c.name === 'Transparent') continue;
          const rgb = c.rgb || [];
          if (rgb.length < 3) continue;
          const dr = r - rgb[0]; const dg = g - rgb[1]; const db = b - rgb[2];
          const d = dr*dr + dg*dg + db*db;
          if (d < bestD) { bestD = d; bestI = i; }
        }
        return bestI;
      };

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = x * drawMult + mid;
          const sy = y * drawMult + mid;
          const p = (sy * bmp.width + sx) * 4;
          const a = data[p + 3] || 0;
          if (a === 0) {
            idxMap[y * w + x] = 0;
          } else {
            const r = data[p] | 0; const g = data[p + 1] | 0; const b = data[p + 2] | 0;
            idxMap[y * w + x] = nearestIdx(r, g, b) || 0;
          }
        }
      }

      tpl.colorIndexTiles[key] = { w, h, data: idxMap };
      if (this.debug) console.debug('[BM] AutoColor: lazily computed index map for', key, { w, h });
    } catch (e) {
      if (this.debug) console.warn('[BM] AutoColor: ensureIndexMapForTemplateTile failed', key, e);
    }
  }

  /** Select a palette color on the site by clicking the corresponding palette element
   * whose id convention is assumed to be `#color-<index>`.
   * @param {number} index - Index into the site's palette (1 = Black), 0 ignored.
   */
  #selectSitePaletteColor(index) {
    if (!index || index <= 0) { return; }

    const dispatchClicks = (el, reason = 'unknown') => {
      if (!el) return false;
      try {
        const isSelected = (
          el.getAttribute?.('aria-pressed') === 'true' ||
          el.classList?.contains('active') ||
          el.classList?.contains('ring-2') ||
          el.classList?.contains('ring-primary') ||
          el.classList?.contains('border-primary')
        );
        if (this.debug) console.debug(`[BM] AutoColor: selecting palette index ${index} via ${reason}. Already selected?`, isSelected, el);
        // Some UIs rely on pointer/mouse events rather than element.click()
        const opts = { view: window, bubbles: true, cancelable: true, composed: true };
        try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (_) { el.click?.(); }
        try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
        return true;
      } catch (e) {
        if (this.debug) console.warn('[BM] AutoColor: dispatchClicks error', e);
        return false;
      }
    };

    // Strategy 1: Expected id convention (#color-<index>)
    let el = document.querySelector(`#color-${index}`);
    if (dispatchClicks(el, `#color-${index}`)) return;

    // Strategy 1a: Zero-based id convention (#color-0 ...), adjust if #color-1 not present but #color-0 is
    const hasColor1 = !!document.querySelector('#color-1');
    const hasColor0 = !!document.querySelector('#color-0');
    if (!hasColor1 && hasColor0) {
      const zeroBased = index - 1;
      if (zeroBased >= 0 && dispatchClicks(document.querySelector(`#color-${zeroBased}`), `#color-${zeroBased} (zero-based)`)) return;
    }

    // Strategy 2: Common data-* attributes
    const attrSelectors = [
      `[data-color-index="${index}"]`,
      `[data-index="${index}"]`,
      `[data-color="${index}"]`,
    ];
    for (const sel of attrSelectors) {
      if (dispatchClicks(document.querySelector(sel), sel)) return;
    }

    // Strategy 3: aria-label pattern matching
    try {
      const ariaCandidate = Array.from(document.querySelectorAll('[aria-label]')).find(n => {
        const t = n.getAttribute('aria-label')?.toLowerCase() || '';
        return (
          t === `color ${index}` ||
          t === `palette color ${index}` ||
          (t.endsWith(` ${index}`) && (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button'))
        );
      });
      if (dispatchClicks(ariaCandidate, 'aria-label')) return;
    } catch (_) { /* ignore */ }

    // Strategy 4: Match by RGB against known palette (if available)
    try {
      const rgb = colorpalette?.[index]?.rgb;
      if (rgb && Array.isArray(rgb)) {
        const [r, g, b] = rgb;
        const target = Array.from(document.querySelectorAll('button, [role="button"], .palette *')).find(node => {
          const cs = window.getComputedStyle(node);
          const bg = cs?.backgroundColor || '';
          const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
          if (!m) return false;
          const R = Number(m[1]), G = Number(m[2]), B = Number(m[3]);
          return R === r && G === g && B === b;
        });
        if (dispatchClicks(target, 'rgb-match')) return;
      }
    } catch (e) { if (this.debug) console.warn('[BM] AutoColor: RGB match strategy failed', e); }

    // Strategy 5: Fallback to palette toolbar ordering (best-effort)
    const paletteButtons = Array.from(document.querySelectorAll('[id^="color-"]'))
      .concat(Array.from(document.querySelectorAll('.palette button, [role="toolbar"] button, .colors button')))
      .filter((v, i, a) => a.indexOf(v) === i); // dedupe
    if (paletteButtons.length) {
      // Assume Transparent is not part of UI; pick (index-1)th item safely
      const idx = Math.max(0, Math.min(paletteButtons.length - 1, index - 1));
      if (dispatchClicks(paletteButtons[idx], 'fallback list')) return;
    }

    if (this.debug) console.warn('[BM] AutoColor: Could not locate palette element for index', index);
  }

  /** Imports the JSON object, and appends it to any JSON object already loaded
   * @param {string} json - The JSON string to parse
   */
  async importJSON(json) {

    console.log(`Importing JSON...`);
    console.log(json);

    // Accept templates matching legacy or dynamic whoami
    const validWhoami = (json?.whoami === 'BlueMarble') || (json?.whoami === this.name.replace(' ', ''));
    // If the passed in JSON is a Thanks to Brioche  template object...
    if (validWhoami) {
      // Store the original JSON so we can persist modifications
      this.templatesJSON = json;
      await this.#parseBlueMarble(json); // ...parse the template object as Thanks to Brioche 
    }
  }

  /** Parses the Thanks to Brioche  JSON object
   * @param {string} json - The JSON string to parse
   * @since 0.72.13
   */
  async #parseBlueMarble(json) {

    console.log(`Parsing BlueMarble...`);

    const templates = json.templates;

    console.log(`BlueMarble length: ${Object.keys(templates).length}`);

    if (Object.keys(templates).length > 0) {

      for (const template in templates) {

        const templateKey = template;
        const templateValue = templates[template];
        console.log(templateKey);

        if (templates.hasOwnProperty(template)) {

          const templateKeyArray = templateKey.split(' '); // E.g., "0 $Z" -> ["0", "$Z"]
          const sortID = Number(templateKeyArray?.[0]); // Sort ID of the template
          const authorID = templateKeyArray?.[1] || '0'; // User ID of the person who exported the template
          const displayName = templateValue.name || `Template ${sortID || ''}`; // Display name of the template
          //const coords = templateValue?.coords?.split(',').map(Number); // "1,2,3,4" -> [1, 2, 3, 4]
          const tilesbase64 = templateValue.tiles;
          const templateTiles = {}; // Stores the template bitmap tiles for each tile.

          for (const tile in tilesbase64) {
            console.log(tile);
            if (tilesbase64.hasOwnProperty(tile)) {
              const encodedTemplateBase64 = tilesbase64[tile];
              const templateUint8Array = base64ToUint8(encodedTemplateBase64); // Base 64 -> Uint8Array

              const templateBlob = new Blob([templateUint8Array], { type: "image/png" }); // Uint8Array -> Blob
              const templateBitmap = await createImageBitmap(templateBlob) // Blob -> Bitmap
              templateTiles[tile] = templateBitmap;
            }
          }

          // Creates a new Template class instance
          // Respect max templates
          if (this.templatesArray.length >= this.maxTemplates) { continue; }

          const templateObj = new Template({
            displayName: displayName,
            sortID: sortID || this.templatesArray?.length || 0,
            authorID: authorID || '',
            enabled: (templateValue.enabled !== false),
            idKey: templateKey,
          });
          templateObj.chunked = templateTiles;
          this.templatesArray.push(templateObj);
          console.log(this.templatesArray);
          console.log(`^^^ This ^^^`);
        }
      }
    }
  }

  /** Parses the OSU! Place JSON object
   */
  #parseOSU() {

  }

  /** Sets the `templatesShouldBeDrawn` boolean to a value.
   * @param {boolean} value - The value to set the boolean to
   * @since 0.73.7
   */
  setTemplatesShouldBeDrawn(value) {
    this.templatesShouldBeDrawn = value;
  }

  /** Returns array summaries for UI: { idKey, name, enabled }
   * @since 0.74.0
   */
  getTemplateSummaries() {
    return (this.templatesArray || []).map(t => ({
      idKey: t?.idKey || `${t?.sortID} ${t?.authorID}`,
      name: t?.displayName || 'Template',
      enabled: !!t?.enabled,
    }));
  }

  /** Enable/Disable a template by idKey with persistence */
  async setTemplateEnabled(idKey, enabled) {
    const t = (this.templatesArray || []).find(x => (x?.idKey || `${x?.sortID} ${x?.authorID}`) === idKey);
    if (!t) { return; }
    t.enabled = !!enabled;
    if (this.templatesJSON?.templates?.[idKey]) {
      this.templatesJSON.templates[idKey].enabled = !!enabled;
    }
    // Invalidate caches and persist
    this.cacheVersion++;
    this.mergedTileCache.clear();
    await this.#storeTemplates();
  }

  /** Remove a template by idKey with persistence */
  async removeTemplate(idKey) {
    const beforeLen = this.templatesArray.length;
    this.templatesArray = (this.templatesArray || []).filter(x => (x?.idKey || `${x?.sortID} ${x?.authorID}`) !== idKey);
    if (beforeLen !== this.templatesArray.length && this.templatesJSON?.templates?.[idKey]) {
      delete this.templatesJSON.templates[idKey];
    }
    // Invalidate caches and persist
    this.cacheVersion++;
    this.mergedTileCache.clear();
    await this.#storeTemplates();
  }
}
