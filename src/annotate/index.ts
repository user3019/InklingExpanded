export { AnnotationController, type AnnotationControllerOptions } from './controller';
export { scaleAnnotationUniform } from './geometry';
export { HistoryStack } from './history';
export { capturePointer, currentZoom, findScrollParent, MAX_ZOOM, releasePointer, zoomAbout } from './pointer';
export { buildToolbar } from './toolbar';
export { ToolState, type ToolStyle } from './toolState';
export { ALL_PRESET_COLORS, paletteFor } from './types';
export type { Annotation, DrawToolType, Point, PresetColor, ShapeToolType, ToolType } from './types';
