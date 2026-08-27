/* =========================================================
   Lectura de archivos GIF

   parseGIF(buffer) devuelve { width, height, frames }, donde cada cuadro
   ya viene compuesto entero (con disposal e interlace resueltos) como
   { data: Uint8ClampedArray RGBA, delay: milisegundos }.
   ========================================================= */

(function (global) {
  'use strict';

  function lzwDecode(minCodeSize, data, pixelCount) {
    const MAX = 4096;
    const out = new Uint8Array(pixelCount);

    const prefix = new Int32Array(MAX);
    const suffix = new Uint8Array(MAX);
    const stack = new Uint8Array(MAX + 1);

    const clear = 1 << minCodeSize;
    const eoi = clear + 1;

    let available = clear + 2;
    let oldCode = -1;
    let codeSize = minCodeSize + 1;
    let codeMask = (1 << codeSize) - 1;

    for (let i = 0; i < clear; i++) {
      prefix[i] = 0;
      suffix[i] = i;
    }

    let datum = 0;
    let bits = 0;
    let first = 0;
    let top = 0;
    let pi = 0;
    let bi = 0;

    for (let i = 0; i < pixelCount;) {
      if (top === 0) {

        if (bits < codeSize) {
          if (bi >= data.length) break;
          datum |= data[bi++] << bits;
          bits += 8;
          continue;
        }

        let code = datum & codeMask;
        datum >>= codeSize;
        bits -= codeSize;

        if (code === eoi) break;

        if (code === clear) {
          codeSize = minCodeSize + 1;
          codeMask = (1 << codeSize) - 1;
          available = clear + 2;
          oldCode = -1;
          continue;
        }

        if (oldCode === -1) {
          stack[top++] = suffix[code];
          oldCode = code;
          first = code;
          continue;
        }

        const inCode = code;

        if (code >= available) {
          stack[top++] = first;
          code = oldCode;
        }

        while (code >= clear) {
          stack[top++] = suffix[code];
          code = prefix[code];
        }

        first = suffix[code] & 0xff;
        stack[top++] = first;

        if (available < MAX) {
          prefix[available] = oldCode;
          suffix[available] = first;
          available++;

          if ((available & codeMask) === 0 && available < MAX) {
            codeSize++;
            codeMask += available;
          }
        }

        oldCode = inCode;
      }

      top--;
      out[pi++] = stack[top];
      i++;
    }

    return out;
  }


  function parseGIF(buffer) {
    const d = new Uint8Array(buffer);

    if (d[0] !== 0x47 || d[1] !== 0x49 || d[2] !== 0x46) {
      throw new Error('El archivo no parece un GIF.');
    }

    let p = 6;

    const W = d[p] | d[p + 1] << 8; p += 2;
    const H = d[p] | d[p + 1] << 8; p += 2;
    const packed = d[p++];
    p += 2;

    let gct = null;
    if (packed & 0x80) {
      const n = 2 << (packed & 7);
      gct = d.subarray(p, p + n * 3);
      p += n * 3;
    }

    const frames = [];
    const comp = new Uint8ClampedArray(W * H * 4);

    let saved = null;
    let prevDisposal = 0;
    let prevRect = null;
    let gce = null;

    const skipBlocks = () => {
      while (p < d.length && d[p] !== 0) p += d[p] + 1;
      p++;
    };

    while (p < d.length) {
      const b = d[p++];

      if (b === 0x3B) break;

      // bloques de extensión
      if (b === 0x21) {
        const label = d[p++];

        if (label === 0xF9) {
          const size = d[p++];
          const pk = d[p];

          gce = {
            disposal: (pk >> 2) & 7,
            transparent: !!(pk & 1),
            tIndex: d[p + 3],
            delay: d[p + 1] | d[p + 2] << 8
          };

          p += size;
          skipBlocks();
        } else {
          skipBlocks();
        }

        continue;
      }

      // descriptor de imagen
      if (b === 0x2C) {
        const left = d[p] | d[p + 1] << 8; p += 2;
        const top = d[p] | d[p + 1] << 8; p += 2;
        const iw = d[p] | d[p + 1] << 8; p += 2;
        const ih = d[p] | d[p + 1] << 8; p += 2;
        const ipk = d[p++];

        let ct = gct;
        if (ipk & 0x80) {
          const n = 2 << (ipk & 7);
          ct = d.subarray(p, p + n * 3);
          p += n * 3;
        }

        const interlaced = !!(ipk & 0x40);
        const minCode = d[p++];

        // los datos vienen en sub-bloques encadenados
        let len = 0;
        let q = p;
        while (q < d.length && d[q] !== 0) {
          len += d[q];
          q += d[q] + 1;
        }

        const raw = new Uint8Array(len);
        let o = 0;
        q = p;
        while (q < d.length && d[q] !== 0) {
          const n = d[q];
          raw.set(d.subarray(q + 1, q + 1 + n), o);
          o += n;
          q += n + 1;
        }
        p = q + 1;

        const idx = lzwDecode(minCode, raw, iw * ih);

        // limpieza que dejó pendiente el cuadro anterior
        if (prevDisposal === 2 && prevRect) {
          const { l, t, w, h } = prevRect;
          for (let y = t; y < t + h && y < H; y++) {
            for (let x = l; x < l + w && x < W; x++) {
              comp[(y * W + x) * 4 + 3] = 0;
            }
          }
        } else if (prevDisposal === 3 && saved) {
          comp.set(saved);
        }

        if (gce && gce.disposal === 3) saved = new Uint8ClampedArray(comp);

        // orden de filas cuando el cuadro es entrelazado
        let rows = null;
        if (interlaced) {
          rows = [];
          for (let i = 0; i < ih; i += 8) rows.push(i);
          for (let i = 4; i < ih; i += 8) rows.push(i);
          for (let i = 2; i < ih; i += 4) rows.push(i);
          for (let i = 1; i < ih; i += 2) rows.push(i);
        }

        const tIdx = (gce && gce.transparent) ? gce.tIndex : -1;

        if (ct) {
          for (let k = 0; k < ih; k++) {
            const dy = top + (interlaced ? rows[k] : k);
            if (dy < 0 || dy >= H) continue;

            for (let x = 0; x < iw; x++) {
              const dx = left + x;
              if (dx < 0 || dx >= W) continue;

              const ci = idx[k * iw + x];
              if (ci === tIdx) continue;

              const s = ci * 3;
              const o2 = (dy * W + dx) * 4;
              comp[o2] = ct[s];
              comp[o2 + 1] = ct[s + 1];
              comp[o2 + 2] = ct[s + 2];
              comp[o2 + 3] = 255;
            }
          }
        }

        const cs = gce ? gce.delay : 10;
        frames.push({
          data: new Uint8ClampedArray(comp),
          delay: (cs <= 1 ? 10 : cs) * 10
        });

        prevDisposal = gce ? gce.disposal : 0;
        prevRect = { l: left, t: top, w: iw, h: ih };
        gce = null;

        continue;
      }

      if (b === 0x00) continue;
      break;
    }

    if (!frames.length) throw new Error('El GIF no tiene cuadros legibles.');

    return { width: W, height: H, frames };
  }


  global.parseGIF = parseGIF;

})(window);
