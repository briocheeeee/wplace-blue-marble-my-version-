import { uint8ToBase64 } from "./utils";
import { colorpalette } from "./utils";

/** An instance of a template.
 * Handles all mathematics, manipulation, and analysis regarding a single template.
 * @class Template
 * @since 0.65.2
 */
export default class Template {

  /** The constructor for the {@link Template} class with enhanced pixel tracking.
   * @param {Object} [params={}] - Object containing all optional parameters
   * @param {string} [params.displayName='My template'] - The display name of the template
   * @param {number} [params.sortID=0] - The sort number of the template for rendering priority
   * @param {string} [params.authorID=''] - The user ID of the person who exported the template (prevents sort ID collisions)
   * @param {string} [params.url=''] - The URL to the source image
   * @param {File} [params.file=null] - The template file (pre-processed File or processed bitmap)
   * @param {Array<number>} [params.coords=null] - The coordinates of the top left corner as (tileX, tileY, pixelX, pixelY)
   * @param {Object} [params.chunked=null] - The affected chunks of the template, and their template for each chunk
   * @param {boolean} [params.autoColor=false] - When true, map colors to the nearest palette color during processing
   * @param {number} [params.tileSize=1000] - The size of a tile in pixels (assumes square tiles)
   * @param {number} [params.pixelCount=0] - Total number of pixels in the template (calculated automatically during processing)
   * @param {boolean} [params.enabled=true] - Whether this template is visible
   * @param {string} [params.idKey=''] - Unique identifier key used in JSON (e.g., "0 $Z")
   * @since 0.65.2
   */
  constructor({
    displayName = 'My template',
    sortID = 0,
    authorID = '',
    url = '',
    file = null,
    coords = null,
    chunked = null,
    autoColor = false,
    tileSize = 1000,
    enabled = true,
    idKey = '',
  } = {}) {
    this.displayName = displayName;
    this.sortID = sortID;
    this.authorID = authorID;
    this.url = url;
    this.file = file;
    this.coords = coords;
    this.chunked = chunked;
    this.autoColor = autoColor;
    this.tileSize = tileSize;
    this.pixelCount = 0; // Total pixel count in template
    this.colorIndexTiles = {}; // Per-tile nearest palette indices for live auto-color
    this.enabled = enabled; // Whether this template is visible
    this.idKey = idKey; // Unique identifier key used in JSON (e.g., "0 $Z")
  }

  // Finds the nearest palette color (excluding Transparent) using squared Euclidean distance
  static #nearestPaletteRGB(r, g, b) {
    let best = null;
    let bestDist = Infinity;
    for (const c of colorpalette) {
      if (c?.name === 'Transparent') { continue; }
      const [pr, pg, pb] = c.rgb || [];
      if (pr === undefined) { continue; }
      const dr = r - pr; const dg = g - pg; const db = b - pb;
      const dist = dr*dr + dg*dg + db*db;
      if (dist < bestDist) { bestDist = dist; best = [pr, pg, pb]; }
    }
    return best || [r, g, b];
  }

  // Finds the nearest palette index (position in colorpalette, skipping Transparent)
  static #nearestPaletteIndex(r, g, b) {
    let bestIndex = 1; // Default to Black
    let bestDist = Infinity;
    for (let i = 0; i < colorpalette.length; i++) {
      const c = colorpalette[i];
      if (!c || c.name === 'Transparent') continue;
      const [pr, pg, pb] = c.rgb || [];
      if (pr === undefined) continue;
      const dr = r - pr; const dg = g - pg; const db = b - pb;
      const dist = dr*dr + dg*dg + db*db;
      if (dist < bestDist) { bestDist = dist; bestIndex = i; }
    }
    return bestIndex;
  }

  /** Creates chunks of the template for each tile.
   * 
   * @returns {Object} Collection of template bitmaps & buffers organized by tile coordinates
   * @since 0.65.4
   */
  async createTemplateTiles() {
    console.log('Template coordinates:', this.coords);

    const shreadSize = 3; // Scale image factor for pixel art enhancement (must be odd)
    const bitmap = await createImageBitmap(this.file); // Create efficient bitmap from uploaded file
    const imageWidth = bitmap.width;
    const imageHeight = bitmap.height;
    
    // Calculate total pixel count using standard width × height formula
    // TODO: Use non-transparent pixels instead of basic width times height
    const totalPixels = imageWidth * imageHeight;
    console.log(`Template pixel analysis - Dimensions: ${imageWidth}×${imageHeight} = ${totalPixels.toLocaleString()} pixels`);
    
    // Store pixel count in instance property for access by template manager and UI components
    this.pixelCount = totalPixels;

    const templateTiles = {}; // Holds the original-color template tiles (masked center pixel)
    const templateTilesAuto = {}; // Holds the auto-colored template tiles (masked center pixel)
    const templateTilesFull = {}; // Holds the original-color template tiles without mask (solid)
    const templateTilesAutoFull = {}; // Holds the auto-colored template tiles without mask (solid)
    const templateTilesBuffers = {}; // Holds the buffers of the original template tiles (masked) for export

    // Reusable canvases to avoid re-allocations inside loops
    const smallCanvas = new OffscreenCanvas(1, 1); // Unscaled working canvas
    const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });

    const largeCanvas = new OffscreenCanvas(1, 1); // Scaled output canvas
    const largeCtx = largeCanvas.getContext('2d');
    largeCtx.imageSmoothingEnabled = false; // Nearest neighbor for scaling

    // Prebuild a repeating dot mask to only keep the center pixel of each shreadSize×shreadSize block
    const maskCanvas = new OffscreenCanvas(shreadSize, shreadSize);
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.clearRect(0, 0, shreadSize, shreadSize);
    maskCtx.fillStyle = '#ffffff';
    const center = Math.floor(shreadSize / 2);
    maskCtx.fillRect(center, center, 1, 1); // Single opaque pixel in the center
    // Pattern will be created per-draw on the destination context

    // For every tile...
    for (let pixelY = this.coords[3]; pixelY < imageHeight + this.coords[3]; ) {

      // Draws the partial tile first, if any
      // This calculates the size based on which is smaller:
      // A. The top left corner of the current tile to the bottom right corner of the current tile
      // B. The top left corner of the current tile to the bottom right corner of the image
      const drawSizeY = Math.min(this.tileSize - (pixelY % this.tileSize), imageHeight - (pixelY - this.coords[3]));

      console.log(`Math.min(${this.tileSize} - (${pixelY} % ${this.tileSize}), ${imageHeight} - (${pixelY - this.coords[3]}))`);

      for (let pixelX = this.coords[2]; pixelX < imageWidth + this.coords[2];) {

        console.log(`Pixel X: ${pixelX}\nPixel Y: ${pixelY}`);

        // Draws the partial tile first, if any
        // This calculates the size based on which is smaller:
        // A. The top left corner of the current tile to the bottom right corner of the current tile
        // B. The top left corner of the current tile to the bottom right corner of the image
        const drawSizeX = Math.min(this.tileSize - (pixelX % this.tileSize), imageWidth - (pixelX - this.coords[2]));

        console.log(`Math.min(${this.tileSize} - (${pixelX} % ${this.tileSize}), ${imageWidth} - (${pixelX - this.coords[2]}))`);

        console.log(`Draw Size X: ${drawSizeX}\nDraw Size Y: ${drawSizeY}`);

        // Step 1: draw the original-size sub-image into a small working canvas
        smallCanvas.width = drawSizeX;
        smallCanvas.height = drawSizeY;
        smallCtx.clearRect(0, 0, drawSizeX, drawSizeY);
        smallCtx.drawImage(
          bitmap,
          pixelX - this.coords[2],
          pixelY - this.coords[3],
          drawSizeX,
          drawSizeY,
          0,
          0,
          drawSizeX,
          drawSizeY
        );

        // Apply #deface and build both original and mapped pixel arrays
        const srcImageData = smallCtx.getImageData(0, 0, drawSizeX, drawSizeY);
        const src = srcImageData.data;
        const orig = new Uint8ClampedArray(src); // copy
        const mapped = new Uint8ClampedArray(src); // will be palette-mapped
        const idxMap = new Uint8Array(drawSizeX * drawSizeY); // 0 means no color/transparent
        for (let y = 0; y < drawSizeY; y++) {
          for (let x = 0; x < drawSizeX; x++) {
            const p = (y * drawSizeX + x) * 4;
            const r = src[p], g = src[p + 1], b = src[p + 2];
            const a = src[p + 3];
            // Treat color #DEFACE specially
            if (r === 222 && g === 250 && b === 206) {
              if ((x + y) % 2 === 0) {
                // translucent black
                orig[p] = 0; orig[p + 1] = 0; orig[p + 2] = 0; orig[p + 3] = 32;
                mapped[p] = 0; mapped[p + 1] = 0; mapped[p + 2] = 0; mapped[p + 3] = 32;
              } else {
                // transparent
                orig[p + 3] = 0; mapped[p + 3] = 0;
              }
              idxMap[y * drawSizeX + x] = 0;
            } else if (a !== 0) {
              // Non-transparent pixel: force full opacity for solid squares
              // Precompute nearest palette index for live auto-color and recolor mapped
              idxMap[y * drawSizeX + x] = Template.#nearestPaletteIndex(r, g, b);
              const [nr, ng, nb] = Template.#nearestPaletteRGB(r, g, b);
              // Keep original RGB in 'orig' but ensure full alpha
              orig[p] = r; orig[p + 1] = g; orig[p + 2] = b; orig[p + 3] = 255;
              // Use nearest palette color in 'mapped' with full alpha
              mapped[p] = nr; mapped[p + 1] = ng; mapped[p + 2] = nb; mapped[p + 3] = 255;
            } else {
              idxMap[y * drawSizeX + x] = 0;
            }
          }
        }

        const origImageData = new ImageData(orig, drawSizeX, drawSizeY);
        const mappedImageData = new ImageData(mapped, drawSizeX, drawSizeY);

        const canvasWidth = drawSizeX * shreadSize;
        const canvasHeight = drawSizeY * shreadSize;

        // Helper to draw small -> large with mask and return bitmap
        const renderToBitmap = (imgData) => {
          smallCtx.putImageData(imgData, 0, 0);
          largeCanvas.width = canvasWidth;
          largeCanvas.height = canvasHeight;
          largeCtx.clearRect(0, 0, canvasWidth, canvasHeight);
          largeCtx.drawImage(smallCanvas, 0, 0, canvasWidth, canvasHeight);
          largeCtx.save();
          largeCtx.globalCompositeOperation = 'destination-in';
          const pattern = largeCtx.createPattern(maskCanvas, 'repeat');
          largeCtx.fillStyle = pattern;
          largeCtx.fillRect(0, 0, canvasWidth, canvasHeight);
          largeCtx.restore();
          return largeCanvas.transferToImageBitmap();
        };

        // Helper to draw small -> large WITHOUT mask and return bitmap (solid preview)
        const renderToBitmapNoMask = (imgData) => {
          smallCtx.putImageData(imgData, 0, 0);
          largeCanvas.width = canvasWidth;
          largeCanvas.height = canvasHeight;
          largeCtx.clearRect(0, 0, canvasWidth, canvasHeight);
          largeCtx.drawImage(smallCanvas, 0, 0, canvasWidth, canvasHeight);
          return largeCanvas.transferToImageBitmap();
        };

        // Creates the "0000,0000,000,000" key name
        const templateTileName = `${(this.coords[0] + Math.floor(pixelX / 1000))
          .toString()
          .padStart(4, '0')},${(this.coords[1] + Math.floor(pixelY / 1000))
          .toString()
          .padStart(4, '0')},${(pixelX % 1000)
          .toString()
          .padStart(3, '0')},${(pixelY % 1000).toString().padStart(3, '0')}`;

        // Store live color index map for this tile region
        this.colorIndexTiles[templateTileName] = { w: drawSizeX, h: drawSizeY, data: idxMap };

        // Render and store both versions
        const bmpOriginal = renderToBitmap(origImageData);
        templateTiles[templateTileName] = bmpOriginal;
        const bmpOriginalFull = renderToBitmapNoMask(origImageData);
        templateTilesFull[templateTileName] = bmpOriginalFull;
        const bmpAuto = renderToBitmap(mappedImageData);
        templateTilesAuto[templateTileName] = bmpAuto;
        const bmpAutoFull = renderToBitmapNoMask(mappedImageData);
        templateTilesAutoFull[templateTileName] = bmpAutoFull;

        // Also persist the original version as buffer for JSON export
        const canvasBlob = await (async () => {
          // Re-draw original into largeCanvas for buffer export
          smallCtx.putImageData(origImageData, 0, 0);
          largeCanvas.width = canvasWidth;
          largeCanvas.height = canvasHeight;
          largeCtx.clearRect(0, 0, canvasWidth, canvasHeight);
          largeCtx.drawImage(smallCanvas, 0, 0, canvasWidth, canvasHeight);
          largeCtx.save();
          largeCtx.globalCompositeOperation = 'destination-in';
          const pattern = largeCtx.createPattern(maskCanvas, 'repeat');
          largeCtx.fillStyle = pattern;
          largeCtx.fillRect(0, 0, canvasWidth, canvasHeight);
          largeCtx.restore();
          return await largeCanvas.convertToBlob();
        })();
        const canvasBuffer = await canvasBlob.arrayBuffer();
        const canvasBufferBytes = Array.from(new Uint8Array(canvasBuffer));
        templateTilesBuffers[templateTileName] = uint8ToBase64(canvasBufferBytes); // Stores the buffer
        
        console.log(templateTiles);

        pixelX += drawSizeX;
      }

      pixelY += drawSizeY;
    }

    console.log('Template Tiles: ', templateTiles);
    console.log('Template Tiles Auto: ', templateTilesAuto);
    console.log('Template Tiles Full: ', templateTilesFull);
    console.log('Template Tiles Auto Full: ', templateTilesAutoFull);
    console.log('Template Tiles Buffers: ', templateTilesBuffers);
    return { templateTiles, templateTilesAuto, templateTilesFull, templateTilesAutoFull, templateTilesBuffers };
  }
}
