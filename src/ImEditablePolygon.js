import EditableShape from '@cogic/annotorious/src/tools/EditableShape';
import { SVG_NAMESPACE, addClass, hasClass, removeClass } from '@cogic/annotorious/src/util/SVG';
import { drawEmbeddedSVG } from '@cogic/annotorious/src/selectors/EmbeddedSVG';
import { format, setFormatterElSize } from '@cogic/annotorious/src/util/Formatting';
import Mask from '@cogic/annotorious/src/tools/polygon/PolygonMask';

import { toSVGTarget } from './ImRubberbandPolygonTool';
import { hasIntersectingEdges } from './utils';

const getPoints = shape =>
  Array.from(shape.querySelector('.a9s-inner').points);

const getBBox = shape =>
  shape.querySelector('.a9s-inner').getBBox();

const distance = (point1, point2) => {
  const dx = point1[0] - point2[0];
  const dy = point1[1] - point2[1];
  return Math.sqrt(dx * dx + dy * dy);
};

const reducePolygonPoints = (points, threshold) => {
  if (points.length < 3) return points; // 多边形至少需要三个顶点

  const reducedPoints = [points[0]]; // 保留第一个顶点

  for (let i = 1; i < points.length; i++) {
    const prevVertex = reducedPoints[reducedPoints.length - 1];
    const currentVertex = points[i];

    if (distance(prevVertex, currentVertex) >= threshold) {
      reducedPoints.push(currentVertex);
    }
  }

  // 检查最后一个顶点与第一个顶点的距离
  if (distance(reducedPoints[reducedPoints.length - 1], reducedPoints[0]) < threshold) {
    reducedPoints.pop();
  }

  return reducedPoints;
};

// 计算点到线段的最短距离
const perpendicularDistance = (point, lineStart, lineEnd) => {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;

  // 如果线段是同一个点，直接计算点间距
  if (x1 === x2 && y1 === y2) {
    return Math.hypot(x - x1, y - y1);
  }

  // 计算线段长度的平方
  const segmentLengthSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  // 计算投影参数 t
  const t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / segmentLengthSq;

  let dx, dy;
  if (t < 0) {
    // 最近点为 lineStart
    dx = x - x1;
    dy = y - y1;
  } else if (t > 1) {
    // 最近点为 lineEnd
    dx = x - x2;
    dy = y - y2;
  } else {
    // 投影点在线段上
    const nearestX = x1 + t * (x2 - x1);
    const nearestY = y1 + t * (y2 - y1);
    dx = x - nearestX;
    dy = y - nearestY;
  }

  return Math.hypot(dx, dy);
}

// 递归应用道格拉斯-普克算法
const douglasPeucker = (points, epsilon) => {
  if (points.length <= 2) return [...points];

  const start = 0;
  const end = points.length - 1;

  // 找到离首尾点连线最远的点
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < end; i++) {
    const distance = perpendicularDistance(points[i], points[start], points[end]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }

  // 根据阈值 epsilon 决定是否分割
  if (maxDistance > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right]; // 避免重复点
  } else {
    return [points[start], points[end]];
  }
}

// 简化多边形入口函数
const simplifyPolygon = (points, epsilon) => {
  if (points.length === 0) return [];

  // 确保多边形闭合（如果未闭合）
  const isClosed = points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
  if (!isClosed) {
    points = [...points, points[0]];
  }

  const simplified = douglasPeucker(points, epsilon);

  // 重新闭合（如果被打开）
  if (
    simplified.length > 0 &&
    (simplified[0][0] !== simplified[simplified.length - 1][0] || simplified[0][1] !== simplified[simplified.length - 1][1])
  ) {
    simplified.push(simplified[0]);
  }

  return simplified;
}

export default class ImEditablePolygon extends EditableShape {

  constructor(annotation, g, config, env) {
    super(annotation, g, config, env);

    this.svg.addEventListener('mousemove', this.onMouseMove);
    this.svg.addEventListener('mouseup', this.onMouseUp);

    this.svg.addEventListener('keyup', this.onKeyUp);

    // Container wraps the mask + editable shape
    this.container = document.createElementNS(SVG_NAMESPACE, 'g');

    // The editable shape group
    this.shape = drawEmbeddedSVG(annotation);
    this.shape.setAttribute('class', 'a9s-annotation editable selected improved-polygon');
    this.shape.setAttribute('data-id', annotation.id);

    const innerPolygon = this.shape.querySelector('.a9s-inner');
    innerPolygon.addEventListener('mousedown', this.onGrab(this.shape));

    // Mask
    this.mask = new Mask(env.image, innerPolygon);

    this.container.appendChild(this.mask.element);
    this.container.appendChild(this.shape);

    const corners = getPoints(this.shape);

    // Corner handles
    this.cornerHandles = corners.map(this.createCornerHandle);

    // Midpoint handles
    this.midpoints = corners.map((_, idx) => this.createMidpoint(corners, idx));

    g.appendChild(this.container);

    // Format needs to go after everything is added to the DOM
    format(this.shape, annotation, config.formatters, this.shape);

    // Grabbed element and grab offset
    this.grabbedElement = null;
    this.grabbedAt = null;

    // Selected corners
    this.selected = [];

    this.lastMouseDown = null;
  }

  _isCornerDistanceTooSmall = (thisCorner, nextCorner) => {
    const minDistance = this.scale * (this.config.handleRadius || 6) * 4;
    return Math.abs(thisCorner.x - nextCorner.x) < minDistance && Math.abs(thisCorner.y - nextCorner.y) < minDistance;
  }

  createCornerHandle = pt => {
    const handle = this.drawHandle(pt.x, pt.y);
    handle.addEventListener('mousedown', this.onGrab(handle));
    handle.addEventListener('click', this.onSelectCorner(handle));

    if (this.config.polygonCornerDeletable) {
      handle.addEventListener('mouseenter', this.onEnterCorner(handle));
      handle.addEventListener('mouseleave', this.onLeaveCorner(handle));
    }

    this.scaleHandle(handle);

    this.shape.appendChild(handle);
    return handle;
  }

  createMidpoint = (corners, idx) => {
    // Create point between this and previous corner
    const thisCorner = corners[idx];
    const nextCorner = idx === corners.length - 1 ? corners[0] : corners[idx + 1];

    const x = (thisCorner.x + nextCorner.x) / 2;
    const y = (thisCorner.y + nextCorner.y) / 2;

    const handle = this.drawMidpoint(x, y, this._isCornerDistanceTooSmall(thisCorner, nextCorner));
    handle.addEventListener('mousedown', this.onGrab(handle));

    this.shape.appendChild(handle);
    return handle;
  }

  deleteSelected = () => {
    const points = getPoints(this.shape);
    
    if (this.selected.length > 0 && (points.length - this.selected.length > 2)) {
      const updatedPoints = points.filter((_, idx) => !this.selected.includes(idx));
      
      // Update corner handles
      const handlesToDelete = this.cornerHandles.filter((_, idx) => this.selected.includes(idx));
      handlesToDelete.forEach(h => h.parentNode.removeChild(h));

      this.cornerHandles = this.cornerHandles.filter((_, idx) => !this.selected.includes(idx));
      
      // Update midpoints
      const midpointsToDelete = this.midpoints.filter((_, idx) => this.selected.includes(idx));
      midpointsToDelete.forEach(m => m.parentNode.removeChild(m));

      this.midpoints = this.midpoints.filter((_, idx) => !this.selected.includes(idx));

      this.setPoints(updatedPoints);
      this.emit('update', toSVGTarget(updatedPoints.map(({x, y}) => [x, y]), this.env.image));
      return true;
    }
    return false;
  }

  deselectCorners = () =>
    this.cornerHandles.forEach(h => removeClass(h, 'selected'));

  destroy = () => {
    this.container.parentNode.removeChild(this.container);

    this.svg.removeEventListener('mousemove', this.onMouseMove);
    this.svg.removeEventListener('mouseup', this.onMouseUp);

    this.svg.removeEventListener('keyup', this.onKeyUp);

    super.destroy();
  }

  drawMidpoint = (x, y, isDistanceTooSmall) => {
    const handle = document.createElementNS(SVG_NAMESPACE, 'circle');
    handle.setAttribute('class', 'a9s-midpoint');

    const radius = this.scale * (this.config.handleRadius || 6) * 0.8;
    
    handle.setAttribute('cx', x);
    handle.setAttribute('cy', y);
    handle.setAttribute('r', radius);

    if (isDistanceTooSmall && this.config.hideMidpointOnSmallDistance) {
      handle.style.display = 'none';
    } else {
      handle.style.display = null;
    }

    return handle;
  }

  get element() {
    return this.shape;
  }

  onAddPoint = (pos, evt) => {
    if (evt.altKey && this.config.polygonCornerDeletable) return;

    const corners = getPoints(this.shape);

    const idx = this.midpoints.indexOf(this.grabbedElement) + 1;

    // Updated polygon points
    const updatedCorners = [
      ...corners.slice(0, idx),
      pos,
      ...corners.slice(idx)
    ];

    // New corner handle
    const cornerHandle = this.createCornerHandle(pos);
    this.cornerHandles = [
      ...this.cornerHandles.slice(0, idx),
      cornerHandle,
      ...this.cornerHandles.slice(idx)
    ];

    // New midpoints left and right 
    const midBefore = this.createMidpoint(updatedCorners, idx - 1);
    const midAfter = this.createMidpoint(updatedCorners, idx);
    this.midpoints = [
      ...this.midpoints.slice(0, idx - 1),
      midBefore,
      midAfter,
      ...this.midpoints.slice(idx)
    ];

    // Delete old midpoint
    this.grabbedElement.parentNode.removeChild(this.grabbedElement);
    
    // Make the newly created corner dragged element + selection
    this.grabbedElement = cornerHandle;
    this.onSelectCorner(cornerHandle)();

    // Update shape
    this.setPoints(updatedCorners);
  }

  onRemovePoint = handle => {
    if (this.cornerHandles.length <= 3) return;

    const handleIdx = this.cornerHandles.indexOf(handle);

    // Updated polygon points
    const updatedCorners = getPoints(this.shape);
    updatedCorners.splice(handleIdx, 1);

    // Delete useless midpoint
    this.midpoints.splice(handleIdx, 1).forEach((minPointElement) => {
      minPointElement.parentNode.removeChild(minPointElement);
    });

    // Delete old corner handle
    this.cornerHandles.splice(handleIdx, 1);
    handle.parentNode.removeChild(handle);

    // Clear corner dragged element + selection
    if (this.grabbedElement === handle) {
      this.grabbedElement = null;
    }
    const handleIdxofSelected = this.selected.indexOf(handleIdx);
    if (handleIdxofSelected >= 0) {
      this.selected.splice(handleIdxofSelected, 1);
    }

    // Update shape
    this.setPoints(updatedCorners);

    // Update SVG
    const points = getPoints(this.shape).map(({x, y}) => [x, y]);
    this.emit('update', toSVGTarget(points, this.env.image));
  }

  onGrab = element => evt => {
    if (evt.button !== 0) return;  // left click

    evt.stopPropagation();

    this.grabbedElement = element;
    this.grabbedAt = this.getSVGPoint(evt);
    this.lastMouseDown = new Date().getTime();
  }

  onKeyUp = evt => {
    if ((evt.key == "Backspace" || evt.key == "Delete") && this.deleteSelected()) {
      evt.preventDefault();
      evt.stopImmediatePropagation();
    }
  }

  simplify = (threshold = 0, type = 0) => {
    const points = getPoints(this.shape).map(({ x, y }) => [x, y]);
    let updatedPoints = [];

    if (type === 0) {
      updatedPoints = reducePolygonPoints(points, threshold);
    } else if (type === 1) {
      updatedPoints = simplifyPolygon(points, threshold);
    }

    if (updatedPoints.length < 3) return;

    // Delete useless midpoint
    this.midpoints.splice(updatedPoints.length).forEach((minPointElement) => {
      minPointElement.parentNode.removeChild(minPointElement);
    });

    // Delete old corner handle
    this.cornerHandles.splice(updatedPoints.length).forEach((handle) => {
      handle.parentNode.removeChild(handle);
    });

    // Clear corner dragged element + selection
    this.grabbedElement = null;
    this.selected.splice(0);

    // Update shape
    this.setPoints(updatedPoints);

    // Update SVG
    this.emit(
      'update',
      toSVGTarget(
        getPoints(this.shape).map(({ x, y }) => [x, y]),
        this.env.image
      )
    );
  }

  onMoveShape = pos => {
    const constrain = (coord, delta, max) =>
      coord + delta < 0 ? -coord : (coord + delta > max ? max - coord : delta);
  
    const { x, y, width, height } = getBBox(this.shape);
    const { naturalWidth, naturalHeight } = this.env.image;

    const dx = constrain(x, pos.x - this.grabbedAt.x, naturalWidth - width);
    const dy = constrain(y, pos.y - this.grabbedAt.y, naturalHeight - height);

    const updatedPoints = getPoints(this.shape).map(pt =>
      ({ x: pt.x + dx, y: pt.y + dy }));

    this.grabbedAt = pos;

    // Update shape
    this.setPoints(updatedPoints);
  }

  onMoveCornerHandle = (pos, evt) => {
    if (evt.altKey && this.config.polygonCornerDeletable) return;

    const handleIdx = this.cornerHandles.indexOf(this.grabbedElement);
    
    // Update selection
    if (evt.ctrlKey && this.config.enableMultiPointSelection !== false) {
      this.selected = Array.from(new Set([...this.selected, handleIdx]));
    } else if (!this.selected.includes(handleIdx)) {
      this.selected = [ handleIdx ];
    }

    // Compute offsets between selected points from current selected
    const points = getPoints(this.shape);

    const distances = this.selected.map(idx => {
      const handleXY = points[handleIdx];
      const thisXY = points[idx];

      return {
        index: idx,
        dx: thisXY.x - handleXY.x,
        dy: thisXY.y - handleXY.y
      }
    });

    const updatedPoints = getPoints(this.shape).map((pt, idx) => {
      let position;

      if (idx === handleIdx) {
        // The dragged point
        position = pos;
      } else if (this.selected.includes(idx)) {
        const { dx, dy } = distances.find(d => d.index === idx);
        position = {
          x: pos.x + dx,
          y: pos.y + dy
        }
      } else {
        // Unchanged
        position = pt;
      }

      const { naturalWidth, naturalHeight } = this.env.image;
      return {
        x: Math.min(Math.max(position.x, 0), naturalWidth),
        y: Math.min(Math.max(position.y, 0), naturalHeight),
      };
    });

    if (
      !(evt.ctrlKey && evt.shiftKey && this.config.enableIntersectionWithShortcut) &&
      this.config.preventIntersection &&
      hasIntersectingEdges([...updatedPoints, updatedPoints[0]])
    ) {
      this.config.onPreventedIntersection?.();
      return;
    }

    this.setPoints(updatedPoints);
  }

  onMouseMove = evt => {
    if (this.grabbedElement) {
      const pos = this.getSVGPoint(evt);

      if (this.grabbedElement === this.shape) {
        this.onMoveShape(pos);
      } else if (hasClass(this.grabbedElement, 'a9s-handle')) {
        this.onMoveCornerHandle(pos, evt);
      } else if (hasClass(this.grabbedElement, 'a9s-midpoint')) {
        this.onAddPoint(pos, evt);
      }

      const points = getPoints(this.shape).map(({x, y}) => [x, y]);
      this.emit('update', toSVGTarget(points, this.env.image));
    }
  }

  onMouseUp = evt => {
    this.grabbedElement = null;
    this.grabbedAt = null;
  }

  onScaleChanged = scale => {
    this.cornerHandles.map(this.scaleHandle);

    this.midpoints.map(midpoint => {
      const radius = this.scale * (this.config.handleRadius || 6) * 0.8;
      midpoint.setAttribute('r', radius);
    });

    this.setPoints(getPoints(this.shape));
  }

  onSelectCorner = handle => evt => {
    if (evt?.altKey && this.config.polygonCornerDeletable) {
      this.onRemovePoint(handle);
      return;
    }

    const isDrag = new Date().getTime() - this.lastMouseDown > 250;

    if (!isDrag) {
      const idx = this.cornerHandles.indexOf(handle);

      if (evt?.ctrlKey && this.config.enableMultiPointSelection !== false ) {
        // Toggle
        if (this.selected.includes(idx))
          this.selected = this.selected.filter(i => i !== idx);
        else 
          this.selected = [...this.selected, idx];
      } else { 
        if (this.selected.length === 1 && this.selected[0] === idx) {
          this.selected = [];
        } else {
          this.selected = [ idx ];
        }
      }

      this.setPoints(getPoints(this.shape));
    }
  }

  onEnterCorner = handle => evt => {
    if (evt.altKey && this.cornerHandles.length > 3 && !hasClass(handle, 'deletable')) {
      addClass(handle, 'deletable');
    }
  }

  onLeaveCorner = handle => evt => {
    if (hasClass(handle, 'deletable')) {
      removeClass(handle, 'deletable');
    }
  }

  setPoints = points => {
    // Not using .toFixed(1) because that will ALWAYS
    // return one decimal, e.g. "15.0" (when we want "15")
    const round = num =>
      Math.round(10 * num) / 10;

    // Set polygon points
    const str = points.map(pt => `${round(pt.x)},${round(pt.y)}`).join(' ');

    const inner = this.shape.querySelector('.a9s-inner');
    inner.setAttribute('points', str);

    const outer = this.shape.querySelector('.a9s-outer');
    outer.setAttribute('points', str);

    // Corner handles
    points.forEach((pt, idx) => this.setHandleXY(this.cornerHandles[idx], pt.x, pt.y));

    this.cornerHandles.forEach((handle, i) => {
      const isSelected = this.selected.includes(i);
      if (isSelected && !hasClass(handle, 'selected')) {
        addClass(handle, 'selected');
      } else if (!isSelected && hasClass(handle, 'selected')) {
        removeClass(handle, 'selected');
      }
    });

    // Midpoints 
    for (let i=0; i<points.length; i++) {
      const thisCorner = points[i];
      const nextCorner = i === points.length - 1 ? points[0] : points[i + 1];

      const x = (thisCorner.x + nextCorner.x) / 2;
      const y = (thisCorner.y + nextCorner.y) / 2;

      const handle = this.midpoints[i];
      handle.setAttribute('cx', x);
      handle.setAttribute('cy', y);

      if (this._isCornerDistanceTooSmall(thisCorner, nextCorner) && this.config.hideMidpointOnSmallDistance) {
        handle.style.display = 'none';
      } else {
        handle.style.display = null;
      }
    }

    // Mask
    this.mask.redraw();

    // Resize formatter elements
    const { x, y, width, height } = inner.getBBox();
    setFormatterElSize(this.shape, x, y, width, height);
  }

  updateState = annotation => {
    const shape = drawEmbeddedSVG(annotation);
    const points = getPoints(shape);
    this.setPoints(points);
  }

}