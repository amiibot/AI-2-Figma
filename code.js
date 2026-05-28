figma.showUI(__html__, { width: 520, height: 640 });

const DEFAULT_SECTION_WIDTH = 960;
const DEFAULT_SECTION_HEIGHT = 240;
const DEFAULT_TEXT_COLOR = '#1F2328';
const DEFAULT_ARTBOARD_FILL = '#FFFFFF';
const FONT_FALLBACKS = ['Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'Inter', 'Roboto'];

const state = {
  structure: null,
  report: null,
  availableFonts: null
};

const postMessage = (message) => {
  figma.ui.postMessage(message);
};

const postBootstrap = () => {
  postMessage({
    type: 'bootstrap',
    page: {
      id: figma.currentPage.id,
      name: figma.currentPage.name
    }
  });
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const clamp01 = (value) => {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
};

const parseHexColor = (hex) => {
  if (typeof hex !== 'string') {
    return null;
  }

  const normalized = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }

  return {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255
  };
};

const withAlpha = (color, alpha) => ({
  r: color.r,
  g: color.g,
  b: color.b,
  a: isFiniteNumber(alpha) ? alpha : 1
});

const parseOffset = (value) => {
  if (typeof value === 'number') {
    return clamp01(value);
  }
  if (typeof value !== 'string') {
    return 0;
  }

  const trimmed = value.trim();
  if (trimmed.endsWith('%')) {
    return clamp01(parseFloat(trimmed.slice(0, -1)) / 100);
  }
  return clamp01(parseFloat(trimmed));
};

const normalizePaintArray = (paints) => Array.isArray(paints) ? paints : [];

const toSolidPaint = (hex, opacity) => {
  const color = parseHexColor(hex);
  if (!color) {
    return null;
  }

  const paint = {
    type: 'SOLID',
    color
  };

  if (isFiniteNumber(opacity)) {
    paint.opacity = opacity;
  }

  return paint;
};

const toGradientPaint = (fill, geometry) => {
  if (!fill || fill.type !== 'linear' || !geometry) {
    return null;
  }

  const width = isFiniteNumber(geometry.width) && geometry.width > 0 ? geometry.width : 1;
  const height = isFiniteNumber(geometry.height) && geometry.height > 0 ? geometry.height : 1;
  const originX = isFiniteNumber(geometry.x) ? geometry.x : 0;
  const originY = isFiniteNumber(geometry.y) ? geometry.y : 0;

  const start = {
    x: ((isFiniteNumber(fill.x1) ? fill.x1 : originX) - originX) / width,
    y: ((isFiniteNumber(fill.y1) ? fill.y1 : originY) - originY) / height
  };
  const end = {
    x: ((isFiniteNumber(fill.x2) ? fill.x2 : originX + width) - originX) / width,
    y: ((isFiniteNumber(fill.y2) ? fill.y2 : originY) - originY) / height
  };

  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 0;
  }

  const third = {
    x: start.x - dy,
    y: start.y + dx
  };

  const gradientStops = Array.isArray(fill.stops)
    ? fill.stops
        .map((stop) => {
          const color = parseHexColor(stop && stop.color);
          if (!color) {
            return null;
          }
          return {
            position: parseOffset(stop.offset),
            color: withAlpha(color, 1)
          };
        })
        .filter(Boolean)
    : [];

  if (gradientStops.length === 0) {
    return null;
  }

  return {
    type: 'GRADIENT_LINEAR',
    gradientStops,
    gradientTransform: [
      [end.x - start.x, third.x - start.x, start.x],
      [end.y - start.y, third.y - start.y, start.y]
    ]
  };
};

const paintFromFill = (fill, geometry) => {
  if (!fill || typeof fill !== 'object') {
    return null;
  }

  if (fill.type === 'solid') {
    return toSolidPaint(fill.color, fill.opacity);
  }

  if (fill.type === 'linear') {
    const gradientPaint = toGradientPaint(fill, geometry);
    if (gradientPaint) {
      return gradientPaint;
    }

    if (Array.isArray(fill.stops) && fill.stops.length > 0) {
      return toSolidPaint(fill.stops[0].color, fill.opacity);
    }
  }

  return null;
};

const applyNodeStyle = (node, style, geometry, defaults) => {
  const nextFills = [];
  if (style && style.fill) {
    const paint = paintFromFill(style.fill, geometry);
    if (paint) {
      nextFills.push(paint);
    }
  } else if (defaults && defaults.fill) {
    const defaultPaint = paintFromFill(defaults.fill, geometry);
    if (defaultPaint) {
      nextFills.push(defaultPaint);
    }
  }
  node.fills = normalizePaintArray(nextFills);

  if (style && style.stroke && style.stroke.color) {
    const strokePaint = toSolidPaint(style.stroke.color, style.stroke.opacity);
    node.strokes = strokePaint ? [strokePaint] : [];
    node.strokeWeight = isFiniteNumber(style.stroke.weight) ? style.stroke.weight : 1;
  } else {
    node.strokes = [];
  }
};

const validateStructure = (structure) => {
  const warnings = [];

  if (!structure || typeof structure !== 'object') {
    throw new Error('structure.json 不是对象。');
  }

  if (typeof structure.documentId !== 'string' || structure.documentId.trim() === '') {
    throw new Error('structure.documentId 缺失。');
  }

  if (!Array.isArray(structure.sections) || structure.sections.length === 0) {
    throw new Error('structure.sections 为空。');
  }

  for (const section of structure.sections) {
    if (!section || typeof section !== 'object') {
      throw new Error('存在无效 section。');
    }

    if (typeof section.id !== 'string' || section.id.trim() === '') {
      throw new Error('存在缺失 id 的 section。');
    }

    if (!section.layout || typeof section.layout !== 'object') {
      throw new Error(section.id + ' 缺失 layout。');
    }

    if (!section.nodes || typeof section.nodes !== 'object') {
      throw new Error(section.id + ' 缺失 nodes。');
    }

    if (!section.nodes.body) {
      throw new Error(section.id + ' 缺失 body 节点定义。');
    }

    if (!section.frame && (!section.nodes.background || !section.nodes.background.geometry)) {
      warnings.push(section.id + ' 缺失 frame/background.geometry，将使用默认位置。');
    }

    if (!section.nodes.background) {
      warnings.push(section.id + ' 没有 background，重建时只创建透明 section 容器。');
    }
  }

  if (!structure.artboard) {
    warnings.push('structure.artboard 缺失，将根据 section 包围盒生成画板。');
  }

  return warnings;
};

const setPluginDataIfAvailable = (node, key, value) => {
  try {
    node.setPluginData(key, value);
  } catch (error) {
    return false;
  }
  return true;
};

const parseFontCandidates = (fontFamily) => {
  const candidates = [];
  if (typeof fontFamily === 'string' && fontFamily.trim()) {
    for (const part of fontFamily.split(',')) {
      const cleaned = part.trim().replace(/^['\"]+|['\"]+$/g, '');
      if (cleaned && candidates.indexOf(cleaned) === -1) {
        candidates.push(cleaned);
      }
    }
  }

  for (const fallback of FONT_FALLBACKS) {
    if (candidates.indexOf(fallback) === -1) {
      candidates.push(fallback);
    }
  }

  return candidates;
};

const fontStylePreferences = (style, textRole) => {
  const preferences = [];
  const rawWeight = style && style.fontWeight ? String(style.fontWeight).toLowerCase() : '';
  const numericWeight = parseInt(rawWeight, 10);

  if (rawWeight.indexOf('bold') >= 0 || (!Number.isNaN(numericWeight) && numericWeight >= 700)) {
    preferences.push('Bold');
    preferences.push('Semibold');
    preferences.push('Medium');
  } else if (rawWeight.indexOf('light') >= 0 || (!Number.isNaN(numericWeight) && numericWeight <= 300)) {
    preferences.push('Light');
    preferences.push('Regular');
  } else if (!Number.isNaN(numericWeight) && numericWeight >= 500) {
    preferences.push('Medium');
    preferences.push('Semibold');
    preferences.push('Regular');
  }

  if (textRole === 'title') {
    preferences.unshift('Semibold');
    preferences.unshift('Bold');
  }

  preferences.push('Regular');

  return preferences.filter((value, index) => preferences.indexOf(value) === index);
};

const getAvailableFonts = async () => {
  if (!state.availableFonts) {
    state.availableFonts = await figma.listAvailableFontsAsync();
  }
  return state.availableFonts;
};

const chooseFont = async (style, textRole) => {
  const availableFonts = await getAvailableFonts();
  const families = parseFontCandidates(style && style.fontFamily ? style.fontFamily : '');
  const wantedStyles = fontStylePreferences(style, textRole);

  for (const family of families) {
    const familyFonts = availableFonts.filter((font) => font.fontName.family === family);
    if (familyFonts.length === 0) {
      continue;
    }

    for (const wantedStyle of wantedStyles) {
      const exact = familyFonts.find((font) => font.fontName.style === wantedStyle);
      if (exact) {
        return exact.fontName;
      }

      const fuzzy = familyFonts.find((font) => font.fontName.style.toLowerCase().indexOf(wantedStyle.toLowerCase()) >= 0);
      if (fuzzy) {
        return fuzzy.fontName;
      }
    }

    return familyFonts[0].fontName;
  }

  return { family: 'Inter', style: textRole === 'title' ? 'Bold' : 'Regular' };
};

const loadFont = async (fontName) => {
  await figma.loadFontAsync(fontName);
};

const computeFallbackArtboard = (sections) => {
  let minX = 0;
  let minY = 0;
  let maxX = DEFAULT_SECTION_WIDTH;
  let maxY = DEFAULT_SECTION_HEIGHT;
  let initialized = false;

  for (const section of sections) {
    const geometry = section && section.frame
      ? section.frame
      : section && section.nodes && section.nodes.background && section.nodes.background.geometry
        ? section.nodes.background.geometry
        : null;

    if (!geometry || !isFiniteNumber(geometry.x) || !isFiniteNumber(geometry.y)) {
      continue;
    }

    const width = isFiniteNumber(geometry.width) ? geometry.width : DEFAULT_SECTION_WIDTH;
    const height = isFiniteNumber(geometry.height) ? geometry.height : DEFAULT_SECTION_HEIGHT;

    if (!initialized) {
      minX = geometry.x;
      minY = geometry.y;
      maxX = geometry.x + width;
      maxY = geometry.y + height;
      initialized = true;
      continue;
    }

    minX = Math.min(minX, geometry.x);
    minY = Math.min(minY, geometry.y);
    maxX = Math.max(maxX, geometry.x + width);
    maxY = Math.max(maxY, geometry.y + height);
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, DEFAULT_SECTION_WIDTH),
    height: Math.max(maxY - minY, DEFAULT_SECTION_HEIGHT)
  };
};

const resolveArtboard = (structure, sections) => {
  if (structure.artboard
    && isFiniteNumber(structure.artboard.width)
    && isFiniteNumber(structure.artboard.height)) {
    return {
      x: isFiniteNumber(structure.artboard.x) ? structure.artboard.x : 0,
      y: isFiniteNumber(structure.artboard.y) ? structure.artboard.y : 0,
      width: structure.artboard.width,
      height: structure.artboard.height
    };
  }

  return computeFallbackArtboard(sections);
};

const resolveSectionGeometry = (section, index) => {
  const frame = section && section.frame ? section.frame : null;
  const backgroundGeometry = section && section.nodes && section.nodes.background && section.nodes.background.geometry
    ? section.nodes.background.geometry
    : null;
  const source = frame || backgroundGeometry;

  if (source && isFiniteNumber(source.x) && isFiniteNumber(source.y)) {
    return {
      x: source.x,
      y: source.y,
      width: isFiniteNumber(source.width) ? source.width : (section.layout.width || DEFAULT_SECTION_WIDTH),
      height: isFiniteNumber(source.height) ? source.height : DEFAULT_SECTION_HEIGHT,
      rx: isFiniteNumber(source.rx) ? source.rx : null,
      ry: isFiniteNumber(source.ry) ? source.ry : null
    };
  }

  return {
    x: 0,
    y: index * (DEFAULT_SECTION_HEIGHT + 48),
    width: section.layout && isFiniteNumber(section.layout.width) ? section.layout.width : DEFAULT_SECTION_WIDTH,
    height: DEFAULT_SECTION_HEIGHT,
    rx: null,
    ry: null
  };
};

const createArtboardFrame = (documentId, artboard) => {
  const frame = figma.createFrame();
  frame.name = 'Import/' + documentId;
  frame.layoutMode = 'NONE';
  frame.resizeWithoutConstraints(artboard.width, artboard.height);
  frame.x = 0;
  frame.y = 0;
  frame.clipsContent = true;
  frame.fills = [toSolidPaint(DEFAULT_ARTBOARD_FILL)];
  frame.strokes = [];
  setPluginDataIfAvailable(frame, 'noticeStruct.documentId', documentId);
  setPluginDataIfAvailable(frame, 'noticeStruct.nodeRole', 'artboard');
  return frame;
};

const resolveParent = (documentId, insertMode, artboard) => {
  if (insertMode === 'current-page') {
    const artboardFrame = createArtboardFrame(documentId, artboard);
    figma.currentPage.appendChild(artboardFrame);
    return artboardFrame;
  }

  const page = figma.createPage();
  page.name = 'Rebuilt/' + documentId;
  const artboardFrame = createArtboardFrame(documentId, artboard);
  page.appendChild(artboardFrame);
  figma.currentPage = page;
  return artboardFrame;
};

const createSectionFrame = (section, geometry, artboard) => {
  const frame = figma.createFrame();
  frame.name = 'Section/' + section.id;
  frame.layoutMode = 'NONE';
  frame.resizeWithoutConstraints(geometry.width, geometry.height);
  frame.x = geometry.x - artboard.x;
  frame.y = geometry.y - artboard.y;
  frame.clipsContent = false;
  frame.fills = [];
  frame.strokes = [];

  if (isFiniteNumber(geometry.rx) && isFiniteNumber(geometry.ry) && geometry.rx === geometry.ry) {
    frame.cornerRadius = geometry.rx;
  } else if (isFiniteNumber(geometry.rx)) {
    frame.cornerRadius = geometry.rx;
  }

  if (section.nodes && section.nodes.background) {
    applyNodeStyle(frame, section.nodes.background.style, section.nodes.background.geometry || geometry, null);
  }

  setPluginDataIfAvailable(frame, 'noticeStruct.sectionId', section.id);
  setPluginDataIfAvailable(frame, 'noticeStruct.nodeRole', 'section');
  setPluginDataIfAvailable(frame, 'noticeStruct.backgroundStrategy', section.layout && section.layout.backgroundStrategy ? section.layout.backgroundStrategy : 'auto');

  return frame;
};

const applyTextMetrics = (node, style, geometry) => {
  if (style && isFiniteNumber(style.fontSize)) {
    node.fontSize = style.fontSize;
  }

  if (geometry && isFiniteNumber(geometry.lineHeight)) {
    node.lineHeight = {
      unit: 'PIXELS',
      value: geometry.lineHeight
    };
  }

  node.textAutoResize = 'NONE';

  if (geometry && isFiniteNumber(geometry.width) && geometry.width > 0) {
    const height = isFiniteNumber(geometry.height) && geometry.height > 0
      ? geometry.height
      : (isFiniteNumber(geometry.lineHeight) ? geometry.lineHeight : 24);
    node.resize(geometry.width, height);
    node.textAutoResize = 'HEIGHT';
  } else {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
};

const positionNodeInSection = (node, geometry, sectionGeometry) => {
  const localX = geometry && isFiniteNumber(geometry.x) ? geometry.x - sectionGeometry.x : 0;
  const localY = geometry && isFiniteNumber(geometry.y) ? geometry.y - sectionGeometry.y : 0;
  node.x = localX;
  node.y = localY;
};

const createTextNode = async (name, textRole, sectionId, content, style, geometry) => {
  const node = figma.createText();
  node.name = name;

  const fontName = await chooseFont(style, textRole);
  await loadFont(fontName);
  node.fontName = fontName;
  node.characters = typeof content === 'string' ? content : '';

  applyTextMetrics(node, style, geometry);
  applyNodeStyle(node, style, geometry, { fill: { type: 'solid', color: DEFAULT_TEXT_COLOR } });

  setPluginDataIfAvailable(node, 'noticeStruct.sectionId', sectionId);
  setPluginDataIfAvailable(node, 'noticeStruct.nodeRole', 'text');
  setPluginDataIfAvailable(node, 'noticeStruct.textRole', textRole);

  return node;
};

const buildSection = async (section, index, artboard) => {
  const sectionGeometry = resolveSectionGeometry(section, index);
  const sectionFrame = createSectionFrame(section, sectionGeometry, artboard);

  if (section.nodes && section.nodes.title) {
    const titleContent = section.content && typeof section.content.titleText === 'string'
      ? section.content.titleText
      : '';
    const titleNode = await createTextNode(
      'Title',
      'title',
      section.id,
      titleContent,
      section.nodes.title.style || {},
      section.nodes.title.geometry || null
    );
    sectionFrame.appendChild(titleNode);
    positionNodeInSection(titleNode, section.nodes.title.geometry || null, sectionGeometry);
  }

  const bodyContent = section.content && typeof section.content.bodyText === 'string' && section.content.bodyText.trim()
    ? section.content.bodyText
    : '[body] ' + section.id;
  const bodyNode = await createTextNode(
    'Body',
    'body',
    section.id,
    bodyContent,
    section.nodes.body.style || {},
    section.nodes.body.geometry || null
  );
  sectionFrame.appendChild(bodyNode);
  positionNodeInSection(bodyNode, section.nodes.body.geometry || null, sectionGeometry);

  return sectionFrame;
};

const rebuildSections = async (request) => {
  if (!state.structure) {
    throw new Error('还没有加载 structure.json。');
  }

  const documentId = request && request.documentId ? request.documentId : state.structure.documentId;
  const wantedIds = new Set(Array.isArray(request && request.sections) ? request.sections : []);
  const selectedSections = state.structure.sections
    .filter((section) => wantedIds.size === 0 || wantedIds.has(section.id))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  if (selectedSections.length === 0) {
    throw new Error('没有可重建的 sections。');
  }

  const insertMode = request && request.options && request.options.insertMode
    ? request.options.insertMode
    : 'new-page';
  const artboard = resolveArtboard(state.structure, selectedSections);
  const parent = resolveParent(documentId, insertMode, artboard);
  const failed = [];
  const createdNodeIds = [parent.id];

  for (let index = 0; index < selectedSections.length; index += 1) {
    const section = selectedSections[index];
    postMessage({
      type: 'rebuild-progress',
      current: index + 1,
      total: selectedSections.length,
      sectionId: section.id,
      sectionName: section.id
    });

    try {
      const node = await buildSection(section, index, artboard);
      parent.appendChild(node);
      createdNodeIds.push(node.id);
    } catch (error) {
      failed.push({
        sectionId: section.id,
        reason: 'SECTION_REBUILD_FAILED',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const createdNodes = await Promise.all(
    createdNodeIds.map((id) => figma.getNodeByIdAsync(id))
  );
  figma.viewport.scrollAndZoomIntoView(createdNodes.filter(Boolean));

  const ok = failed.length === 0;
  postMessage({
    type: 'rebuild-result',
    ok,
    createdCount: createdNodeIds.length - 1,
    createdNodeIds,
    failed
  });

  if (ok) {
    figma.notify('已按画板坐标重建 ' + (createdNodeIds.length - 1) + ' 个 section。');
  } else if (createdNodeIds.length > 1) {
    figma.notify('已重建 ' + (createdNodeIds.length - 1) + ' 个 section，' + failed.length + ' 个失败。');
  } else {
    figma.notify('没有成功重建任何 section。');
  }
};

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'request-bootstrap') {
    postBootstrap();
    return;
  }

  if (msg.type === 'load-structure') {
    try {
      const warnings = validateStructure(msg.structure);
      state.structure = msg.structure;
      state.report = msg.report || null;
      postMessage({
        type: 'structure-accepted',
        documentId: msg.structure.documentId,
        sectionCount: msg.structure.sections.length,
        warnings
      });
    } catch (error) {
      postMessage({
        type: 'error',
        code: 'INVALID_STRUCTURE',
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (msg.type === 'rebuild-sections') {
    try {
      await rebuildSections(msg);
    } catch (error) {
      postMessage({
        type: 'error',
        code: 'REBUILD_FAILED',
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

postBootstrap();
