import { addClass, hasClass, removeClass } from '@cogic/annotorious/src/util/SVG';

/**
 * 判断线段是否相交
 * 参考 https://www.cnblogs.com/fangsmile/articles/8881139.html
 * @param a - 线段 1 一端坐标
 * @param b - 线段 1 另一端坐标
 * @param c - 线段 2 一端坐标
 * @param d - 线段 2 另一端坐标
 * @returns {boolean}
 */
function isSegmentsIntersect(a, b, c, d) {
  // 三角形abc 面积的2倍
  const area_abc = (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x);

  // 三角形abd 面积的2倍
  const area_abd = (a.x - d.x) * (b.y - d.y) - (a.y - d.y) * (b.x - d.x);

  // 面积符号相同则两点在线段同侧,不相交 (对点在线段上的情况,本例当作不相交处理);
  if (area_abc * area_abd >= 0) {
    return false;
  }

  // 三角形cda 面积的2倍
  const area_cda = (c.x - a.x) * (d.y - a.y) - (c.y - a.y) * (d.x - a.x);
  // 三角形cdb 面积的2倍
  // 注意: 这里有一个小优化.不需要再用公式计算面积,而是通过已知的三个面积加减得出.
  const area_cdb = area_cda + area_abc - area_abd;
  if (area_cda * area_cdb >= 0) {
    return false;
  }

  return true;
}

/**
 * 判断折线是否有相交边
 * @param {*} points - 折线所有点
 * @returns {boolean | Array}
 */
export function hasIntersectingEdges(points) {
  const n = points.length;
  const transPos = (pos) => {
    return Array.isArray(pos) ? { x: pos[0], y: pos[1] } : pos;
  };
  for (let i = 0; i <= n - 3; i++) {
    const p1 = transPos(points[i]);
    const p2 = transPos(points[i + 1]);
    for (let j = i + 1; j <= n - 2; j++) {
      const p3 = transPos(points[j]);
      const p4 = transPos(points[j + 1]);
      if (isSegmentsIntersect(p1, p2, p3, p4)) {
        return [p1, p2, p3, p4];
      }
    }
  }
  return false;
}

/**
 * Check and mark self-intersecting polygon
 */
export function markSelfIntersecting(shape, selfIntersecting) {
  if (selfIntersecting) {
    shape && !hasClass(shape, 'self-intersecting') && addClass(shape, 'self-intersecting');
  } else {
    shape && hasClass(shape, 'self-intersecting') && removeClass(shape, 'self-intersecting');
  }
}
