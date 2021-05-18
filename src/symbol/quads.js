// @flow

import Point from '@mapbox/point-geometry';

import {GLYPH_PBF_BORDER} from '../style/parse_glyph_pbf.js';

import type Anchor from './anchor.js';
import type {PositionedIcon, Shaping} from './shaping.js';
import {SHAPING_DEFAULT_OFFSET} from './shaping.js';
import {IMAGE_PADDING} from '../render/image_atlas.js';
import {SDF_SCALE} from '../render/glyph_manager.js';
import type SymbolStyleLayer from '../style/style_layer/symbol_style_layer.js';
import type {Feature} from '../style-spec/expression/index.js';
import type {StyleImage} from '../style/style_image.js';
import ONE_EM from './one_em.js';

/**
 * A textured quad for rendering a single icon or glyph.
 *
 * The zoom range the glyph can be shown is defined by minScale and maxScale.
 *
 * @param tl The offset of the top left corner from the anchor.
 * @param tr The offset of the top right corner from the anchor.
 * @param bl The offset of the bottom left corner from the anchor.
 * @param br The offset of the bottom right corner from the anchor.
 * @param tex The texture coordinates.
 *
 * @private
 */
export type SymbolQuad = {
    tl: Point,
    tr: Point,
    bl: Point,
    br: Point,
    tex: {
        x: number,
        y: number,
        w: number,
        h: number
    },
    pixelOffsetTL: Point,
    pixelOffsetBR: Point,
    writingMode: any | void,
    glyphOffset: [number, number],
    sectionIndex: number,
    isSDF: boolean,
    minFontScaleX: number,
    minFontScaleY: number
};

// If you have a 10px icon that isn't perfectly aligned to the pixel grid it will cover 11 actual
// pixels. The quad needs to be padded to account for this, otherwise they'll look slightly clipped
// on one edge in some cases.
const border = IMAGE_PADDING;

/**
 * Create the quads used for rendering an icon.
 * @private
 */
export function getIconQuads(
                      shapedIcon: PositionedIcon,
                      iconRotate: number,
                      isSDFIcon: boolean,
                      hasIconTextFit: boolean): Array<SymbolQuad> {
    const quads = [];

    const image = shapedIcon.image;
    const pixelRatio = image.pixelRatio;
    const imageWidth = image.paddedRect.w - 2 * border;
    const imageHeight = image.paddedRect.h - 2 * border;

    const iconWidth = shapedIcon.right - shapedIcon.left;
    const iconHeight = shapedIcon.bottom - shapedIcon.top;

    const stretchX = image.stretchX || [[0, imageWidth]];
    const stretchY = image.stretchY || [[0, imageHeight]];

    const reduceRanges = (sum, range) => sum + range[1] - range[0];
    const stretchWidth = stretchX.reduce(reduceRanges, 0);
    const stretchHeight = stretchY.reduce(reduceRanges, 0);
    const fixedWidth = imageWidth - stretchWidth;
    const fixedHeight = imageHeight - stretchHeight;

    let stretchOffsetX = 0;
    let stretchContentWidth = stretchWidth;
    let stretchOffsetY = 0;
    let stretchContentHeight = stretchHeight;
    let fixedOffsetX = 0;
    let fixedContentWidth = fixedWidth;
    let fixedOffsetY = 0;
    let fixedContentHeight = fixedHeight;

    if (image.content && hasIconTextFit) {
        const content = image.content;
        stretchOffsetX = sumWithinRange(stretchX, 0, content[0]);
        stretchOffsetY = sumWithinRange(stretchY, 0, content[1]);
        stretchContentWidth = sumWithinRange(stretchX, content[0], content[2]);
        stretchContentHeight = sumWithinRange(stretchY, content[1], content[3]);
        fixedOffsetX = content[0] - stretchOffsetX;
        fixedOffsetY = content[1] - stretchOffsetY;
        fixedContentWidth = content[2] - content[0] - stretchContentWidth;
        fixedContentHeight = content[3] - content[1] - stretchContentHeight;
    }

    const makeBox = (left, top, right, bottom) => {

        const leftEm = getEmOffset(left.stretch - stretchOffsetX, stretchContentWidth, iconWidth, shapedIcon.left);
        const leftPx = getPxOffset(left.fixed - fixedOffsetX, fixedContentWidth, left.stretch, stretchWidth);

        const topEm = getEmOffset(top.stretch - stretchOffsetY, stretchContentHeight, iconHeight, shapedIcon.top);
        const topPx = getPxOffset(top.fixed - fixedOffsetY, fixedContentHeight, top.stretch, stretchHeight);

        const rightEm = getEmOffset(right.stretch - stretchOffsetX, stretchContentWidth, iconWidth, shapedIcon.left);
        const rightPx = getPxOffset(right.fixed - fixedOffsetX, fixedContentWidth, right.stretch, stretchWidth);

        const bottomEm = getEmOffset(bottom.stretch - stretchOffsetY, stretchContentHeight, iconHeight, shapedIcon.top);
        const bottomPx = getPxOffset(bottom.fixed - fixedOffsetY, fixedContentHeight, bottom.stretch, stretchHeight);

        const tl = new Point(leftEm, topEm);
        const tr = new Point(rightEm, topEm);
        const br = new Point(rightEm, bottomEm);
        const bl = new Point(leftEm, bottomEm);
        const pixelOffsetTL = new Point(leftPx / pixelRatio, topPx / pixelRatio);
        const pixelOffsetBR = new Point(rightPx / pixelRatio, bottomPx / pixelRatio);

        const angle = iconRotate * Math.PI / 180;

        if (angle) {
            const sin = Math.sin(angle),
                cos = Math.cos(angle),
                matrix = [cos, -sin, sin, cos];

            tl._matMult(matrix);
            tr._matMult(matrix);
            bl._matMult(matrix);
            br._matMult(matrix);
        }

        const x1 = left.stretch + left.fixed;
        const x2 = right.stretch + right.fixed;
        const y1 = top.stretch + top.fixed;
        const y2 = bottom.stretch + bottom.fixed;

        const subRect = {
            x: image.paddedRect.x + border + x1,
            y: image.paddedRect.y + border + y1,
            w: x2 - x1,
            h: y2 - y1
        };

        const minFontScaleX = fixedContentWidth / pixelRatio / iconWidth;
        const minFontScaleY = fixedContentHeight / pixelRatio / iconHeight;

        // Icon quad is padded, so texture coordinates also need to be padded.
        return {tl, tr, bl, br, tex: subRect, writingMode: undefined, glyphOffset: [0, 0], sectionIndex: 0, pixelOffsetTL, pixelOffsetBR, minFontScaleX, minFontScaleY, isSDF: isSDFIcon};
    };

    if (!hasIconTextFit || (!image.stretchX && !image.stretchY)) {
        quads.push(makeBox(
            {fixed: 0, stretch: -1},
            {fixed: 0, stretch: -1},
            {fixed: 0, stretch: imageWidth + 1},
            {fixed: 0, stretch: imageHeight + 1}));
    } else {
        const xCuts = stretchZonesToCuts(stretchX, fixedWidth, stretchWidth);
        const yCuts = stretchZonesToCuts(stretchY, fixedHeight, stretchHeight);

        for (let xi = 0; xi < xCuts.length - 1; xi++) {
            const x1 = xCuts[xi];
            const x2 = xCuts[xi + 1];
            for (let yi = 0; yi < yCuts.length - 1; yi++) {
                const y1 = yCuts[yi];
                const y2 = yCuts[yi + 1];
                quads.push(makeBox(x1, y1, x2, y2));
            }
        }
    }

    return quads;
}

function sumWithinRange(ranges, min, max) {
    let sum = 0;
    for (const range of ranges) {
        sum += Math.max(min, Math.min(max, range[1])) - Math.max(min, Math.min(max, range[0]));
    }
    return sum;
}

function stretchZonesToCuts(stretchZones, fixedSize, stretchSize) {
    const cuts = [{fixed: -border, stretch: 0}];

    for (const [c1, c2] of stretchZones) {
        const last = cuts[cuts.length - 1];
        cuts.push({
            fixed: c1 - last.stretch,
            stretch: last.stretch
        });
        cuts.push({
            fixed: c1 - last.stretch,
            stretch: last.stretch + (c2 - c1)
        });
    }
    cuts.push({
        fixed: fixedSize + border,
        stretch: stretchSize
    });
    return cuts;
}

function getEmOffset(stretchOffset, stretchSize, iconSize, iconOffset) {
    return stretchOffset / stretchSize * iconSize + iconOffset;
}

function getPxOffset(fixedOffset, fixedSize, stretchOffset, stretchSize) {
    return fixedOffset - fixedSize * stretchOffset / stretchSize;
}

/**
 * Create the quads used for rendering a text label.
 * @private
 */
export function getGlyphQuads(anchor: Anchor,
                       shaping: Shaping,
                       textOffset: [number, number],
                       layer: SymbolStyleLayer,
                       alongLine: boolean,
                       feature: Feature,
                       imageMap: {[_: string]: StyleImage},
                       allowVerticalPlacement: boolean): Array<SymbolQuad> {

    const textRotate = layer.layout.get('text-rotate').evaluate(feature, {}) * Math.PI / 180;
    const quads = [];

    if (shaping.positionedLines.length === 0) return quads;
    let shapingHeight = Math.abs(shaping.top - shaping.bottom);
    for (const line of shaping.positionedLines) {
        shapingHeight -= line.lineOffset;
    }
    const lineCounts = shaping.positionedLines.length;
    const lineHeight = shapingHeight / lineCounts;
    const getMidlineOffset = function(shaping, lineHeight, previousOffset, lineIndex) {
        const currentLineHeight = (lineHeight + shaping.positionedLines[lineIndex].lineOffset);
        if (lineIndex === 0) {
            return previousOffset + currentLineHeight / 2.0;
        }
        const aboveLineHeight = (lineHeight + shaping.positionedLines[lineIndex - 1].lineOffset);
        return previousOffset + (currentLineHeight + aboveLineHeight) / 2.0;
    };
    let currentOffset = shaping.top;
    for (let lineIndex = 0; lineIndex < lineCounts; ++lineIndex) {
        const line = shaping.positionedLines[lineIndex];
        currentOffset = getMidlineOffset(shaping, lineHeight, currentOffset, lineIndex);
        for (const positionedGlyph of line.positionedGlyphs) {
            if (!positionedGlyph.rect) continue;
            const textureRect = positionedGlyph.rect || {};

            // The rects have an additional buffer that is not included in their size.
            const glyphPadding = 1.0;
            let rectBuffer = GLYPH_PBF_BORDER + glyphPadding;
            let isSDF = true;
            let pixelRatio = 1.0;
            let lineOffset = 0.0;

            const rotateVerticalGlyph = (alongLine || allowVerticalPlacement) && positionedGlyph.vertical;
            const halfAdvance = positionedGlyph.metrics.advance * positionedGlyph.scale / 2;

            // Align images and scaled glyphs in the middle of a vertical line.
            if (allowVerticalPlacement && shaping.verticalizable) {
                // image's advance for vertical shaping is its height, so that we have to take the difference into
                // account after image glyph is rotated
                lineOffset = positionedGlyph.imageName ? halfAdvance - positionedGlyph.metrics.width * positionedGlyph.scale / 2.0 : 0;
            }

            if (positionedGlyph.imageName) {
                const image = imageMap[positionedGlyph.imageName];
                if (!image) continue;
                isSDF = image.sdf;
                pixelRatio = image.pixelRatio;
                rectBuffer = IMAGE_PADDING / pixelRatio;
            }

            const glyphOffset = alongLine ?
                [positionedGlyph.x + halfAdvance, positionedGlyph.y] :
                [0, 0];

            let builtInOffset = alongLine ?
                [0, 0] :
                [positionedGlyph.x + halfAdvance + textOffset[0], positionedGlyph.y + textOffset[1] - lineOffset];

            let verticalizedLabelOffset = [0, 0];
            if (rotateVerticalGlyph) {
                // Vertical POI labels that are rotated 90deg CW and whose glyphs must preserve upright orientation
                // need to be rotated 90deg CCW. After a quad is rotated, it is translated to the original built-in offset.
                verticalizedLabelOffset = builtInOffset;
                builtInOffset = [0, 0];
            }

            const x1 = (positionedGlyph.metrics.left - rectBuffer) * positionedGlyph.scale - halfAdvance + builtInOffset[0];
            const y1 = (-positionedGlyph.metrics.top - rectBuffer) * positionedGlyph.scale + builtInOffset[1];
            const x2 = x1 + textureRect.w * positionedGlyph.scale / (pixelRatio * (positionedGlyph.localGlyph ? SDF_SCALE : 1));
            const y2 = y1 + textureRect.h * positionedGlyph.scale / (pixelRatio * (positionedGlyph.localGlyph ? SDF_SCALE : 1));

            const tl = new Point(x1, y1);
            const tr = new Point(x2, y1);
            const bl = new Point(x1, y2);
            const br = new Point(x2, y2);

            if (rotateVerticalGlyph) {
                // Vertical-supporting glyphs are laid out in 24x24 point boxes (1 square em)
                // In horizontal orientation, the "yShift" is the negative value of the height that
                // the glyph is above the horizontal midline.
                // By rotating counter-clockwise around the point at the center of the left
                // edge of a 24x24 layout box centered below the midline, we align the center
                // of the glyphs with the horizontal midline, so the yShift is no longer
                // necessary, but we also pull the glyph to the left along the x axis.
                // Since the y coordinate includes yShift, therefore, needs to be accounted
                // for when glyph is rotated and translated.
                const yShift = positionedGlyph.y - currentOffset;
                const center = new Point(-halfAdvance, halfAdvance - yShift);
                const verticalRotation = -Math.PI / 2;

                // xHalfWidthOffsetCorrection is a difference between full-width and half-width
                // advance, should be 0 for full-width glyphs and will pull up half-width glyphs.
                const xHalfWidthOffsetCorrection = ONE_EM / 2 - halfAdvance;
                const halfWidthOffsetCorrection = new Point(5 - yShift - xHalfWidthOffsetCorrection, 0);
                const verticalOffsetCorrection = new Point(...verticalizedLabelOffset);
                tl._rotateAround(verticalRotation, center)._add(halfWidthOffsetCorrection)._add(verticalOffsetCorrection);
                tr._rotateAround(verticalRotation, center)._add(halfWidthOffsetCorrection)._add(verticalOffsetCorrection);
                bl._rotateAround(verticalRotation, center)._add(halfWidthOffsetCorrection)._add(verticalOffsetCorrection);
                br._rotateAround(verticalRotation, center)._add(halfWidthOffsetCorrection)._add(verticalOffsetCorrection);
            }

            if (textRotate) {
                const sin = Math.sin(textRotate),
                    cos = Math.cos(textRotate),
                    matrix = [cos, -sin, sin, cos];

                tl._matMult(matrix);
                tr._matMult(matrix);
                bl._matMult(matrix);
                br._matMult(matrix);
            }

            const pixelOffsetTL = new Point(0, 0);
            const pixelOffsetBR = new Point(0, 0);
            const minFontScaleX = 0;
            const minFontScaleY = 0;
            quads.push({tl, tr, bl, br, tex: textureRect, writingMode: shaping.writingMode, glyphOffset, sectionIndex: positionedGlyph.sectionIndex, isSDF, pixelOffsetTL, pixelOffsetBR, minFontScaleX, minFontScaleY});
        }
    }

    return quads;
}
