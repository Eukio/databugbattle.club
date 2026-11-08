// Small vector icons drawn with canvas paths. Each takes the top-left corner and a size in CSS px.
type Ctx = CanvasRenderingContext2D;

function shieldPath(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x + s / 2, y);
  ctx.lineTo(x + s, y + s * 0.18);
  ctx.lineTo(x + s * 0.92, y + s * 0.62);
  ctx.lineTo(x + s / 2, y + s);
  ctx.lineTo(x + s * 0.08, y + s * 0.62);
  ctx.lineTo(x, y + s * 0.18);
  ctx.closePath();
}

export function shield(ctx: Ctx, x: number, y: number, s: number, color: string, variant: 'full' | 'open' | 'broken' | 'cracked' | 'small'): void {
  ctx.save();
  ctx.lineWidth = Math.max(1, s / 8);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (variant === 'small') {
    shieldPath(ctx, x + s * 0.2, y + s * 0.2, s * 0.6);
    ctx.globalAlpha = 0.85;
    ctx.fill();
  } else if (variant === 'full') {
    shieldPath(ctx, x, y, s);
    ctx.fill();
  } else if (variant === 'open') {
    shieldPath(ctx, x, y, s);
    ctx.stroke();
  } else if (variant === 'cracked') {
    shieldPath(ctx, x, y, s);
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(x + s * 0.5, y + s * 0.1);
    ctx.lineTo(x + s * 0.38, y + s * 0.45);
    ctx.lineTo(x + s * 0.6, y + s * 0.58);
    ctx.lineTo(x + s * 0.48, y + s * 0.92);
    ctx.stroke();
  } else {
    // broken: two halves pulled apart
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 1, y - 1, s * 0.46 + 1, s + 2);
    ctx.clip();
    shieldPath(ctx, x - s * 0.06, y, s);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + s * 0.54, y - 1, s * 0.46 + 1, s + 2);
    ctx.clip();
    shieldPath(ctx, x + s * 0.06, y, s);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

export function warning(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + s / 2, y);
  ctx.lineTo(x + s, y + s);
  ctx.lineTo(x, y + s);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.fillRect(x + s * 0.45, y + s * 0.35, s * 0.1, s * 0.35);
  ctx.fillRect(x + s * 0.45, y + s * 0.78, s * 0.1, s * 0.1);
  ctx.restore();
}

export function wrench(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, s / 4.5);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.2, y + s * 0.8);
  ctx.lineTo(x + s * 0.62, y + s * 0.38);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, s / 7);
  ctx.beginPath();
  ctx.arc(x + s * 0.7, y + s * 0.3, s * 0.24, Math.PI * 0.85, Math.PI * 2.15);
  ctx.stroke();
  ctx.restore();
}

export function lock(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s / 7);
  ctx.fillRect(x + s * 0.15, y + s * 0.45, s * 0.7, s * 0.55);
  ctx.beginPath();
  ctx.arc(x + s / 2, y + s * 0.45, s * 0.24, Math.PI, 0);
  ctx.stroke();
  ctx.restore();
}

export function bug(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s / 9);
  ctx.beginPath();
  ctx.ellipse(x + s / 2, y + s * 0.6, s * 0.26, s * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  // legs
  for (const dy of [0.45, 0.62, 0.8]) {
    ctx.moveTo(x + s * 0.1, y + s * dy);
    ctx.lineTo(x + s * 0.9, y + s * dy);
  }
  // antennae
  ctx.moveTo(x + s * 0.42, y + s * 0.3);
  ctx.lineTo(x + s * 0.28, y + s * 0.05);
  ctx.moveTo(x + s * 0.58, y + s * 0.3);
  ctx.lineTo(x + s * 0.72, y + s * 0.05);
  ctx.stroke();
  ctx.restore();
}

/** Server rack: three bars with status dots, drawn faintly behind a DC's number. */
export function rack(ctx: Ctx, x: number, y: number, s: number, color: string, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const bw = s * 0.7, bh = s * 0.16, gap = s * 0.08;
  const top = y + (s - (3 * bh + 2 * gap)) / 2;
  for (let k = 0; k < 3; k++) {
    const by = top + k * (bh + gap);
    ctx.fillRect(x + (s - bw) / 2, by, bw, bh);
  }
  ctx.restore();
}

export function mountain(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + s * 0.12, y + s * 0.78);
  ctx.lineTo(x + s * 0.42, y + s * 0.28);
  ctx.lineTo(x + s * 0.56, y + s * 0.5);
  ctx.lineTo(x + s * 0.68, y + s * 0.36);
  ctx.lineTo(x + s * 0.9, y + s * 0.78);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function cross(ctx: Ctx, cx: number, cy: number, r: number, color: string, width: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

export function hatch(ctx: Ctx, x: number, y: number, s: number, color: string, step: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = -s; d < s; d += step) {
    ctx.moveTo(x + d, y + s);
    ctx.lineTo(x + d + s, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** HQ marker: a small crown. */
export function crown(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.75);
  ctx.lineTo(x + s * 0.08, y + s * 0.2);
  ctx.lineTo(x + s * 0.32, y + s * 0.48);
  ctx.lineTo(x + s * 0.5, y + s * 0.05);
  ctx.lineTo(x + s * 0.68, y + s * 0.48);
  ctx.lineTo(x + s * 0.92, y + s * 0.2);
  ctx.lineTo(x + s, y + s * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
