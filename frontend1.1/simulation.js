/* Machado, Oliveira & Fernandes (2009), severity 1.0 matrices.
   Work in linear-light sRGB, not gamma-encoded canvas bytes.
   Blue-yellow endpoint is a severe tritanomaly approximation.
   Reference and limitations: ../docs/INTEGRATION.md and ../README.md. */
(function (root) {
  'use strict';
  const matrices = {
    deuteranopia: [.367322,.860646,-.227968,.280085,.672501,.047413,-.011820,.042940,.968881],
    protanopia: [.152286,1.052583,-.204868,.114503,.786281,.099216,-.003882,-.048116,1.051998],
    tritanopia: [1.255528,-.076749,-.178779,-.078411,.930809,.147602,.004733,.691367,.303900]
  };
  const linear = Float64Array.from({length:256}, (_, i) => {
    const c = i / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  function encode(c) {
    c = Math.max(0, Math.min(1, c));
    return Math.round(255 * (c <= .0031308 ? 12.92*c : 1.055*c**(1/2.4)-.055));
  }
  function simulate(bytes, mode) {
    const out = new Uint8ClampedArray(bytes);
    if (mode === 'normal') return out;
    const m = matrices[mode];
    if (!m) throw new Error('Unknown simulation mode.');
    for (let i=0; i<out.length; i+=4) {
      const r=linear[bytes[i]], g=linear[bytes[i+1]], b=linear[bytes[i+2]];
      out[i]=encode(m[0]*r+m[1]*g+m[2]*b);
      out[i+1]=encode(m[3]*r+m[4]*g+m[5]*b);
      out[i+2]=encode(m[6]*r+m[7]*g+m[8]*b);
    }
    return out;
  }
  root.ChartSafeSimulation = {simulate};
  if (typeof module !== 'undefined') module.exports = {simulate};
})(typeof window !== 'undefined' ? window : globalThis);
