function renderBodyDiagram(volumes, targets) {
  const fillFor = (id) => {
    const target = targets[id];
    const ratio = target && target.mav[0] ? (volumes[id] || 0) / target.mav[0] : 0;
    if (!ratio) return '#1d2521';
    if (ratio < 0.5) return '#4a6b3f';
    if (ratio < 1) return '#7fb069';
    if (ratio < 1.2) return '#94c37d';
    return '#d4a04a';
  };
  const part = (id, d, cls = '') => `<path class="body-part ${cls}" data-muscle="${id}" fill="${fillFor(id)}" d="${d}" />`;
  return `
    <svg class="body-map" viewBox="0 0 320 254" role="img" aria-label="weekly muscle volume heatmap">
      <defs>
        <linearGradient id="diagram-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#7fb069" stop-opacity=".10" />
          <stop offset="1" stop-color="#7fb069" stop-opacity="0" />
        </linearGradient>
      </defs>
      <text class="diagram-label" x="83" y="248">front</text>
      <text class="diagram-label" x="223" y="248">back</text>
      <ellipse fill="url(#diagram-glow)" cx="91" cy="132" rx="65" ry="115"/>
      <ellipse fill="url(#diagram-glow)" cx="229" cy="132" rx="65" ry="115"/>
      <g transform="translate(45 10)">
        <circle class="body-outline" cx="46" cy="15" r="14"/>
        ${part('front_delts', 'M22 42 Q13 49 12 72 L23 75 L31 55 Z M70 55 L78 75 L89 72 Q88 49 79 42 Z')}
        ${part('chest', 'M31 40 Q46 34 61 40 L62 63 Q46 70 30 63 Z')}
        ${part('side_delts', 'M19 44 Q11 51 10 67 L19 69 L28 48 Z M64 48 L73 69 L82 67 Q81 51 73 44 Z')}
        ${part('triceps', 'M11 70 L22 73 L20 101 L12 101 Z M70 73 L81 70 L80 101 L72 101 Z')}
        ${part('abs', 'M35 67 L57 67 L58 111 Q46 116 34 111 Z')}
        ${part('obliques', 'M27 67 L35 68 L34 112 L25 102 Z M57 68 L65 67 L67 102 L58 112 Z')}
        ${part('quads', 'M26 116 Q36 111 44 116 L43 171 Q35 180 26 171 Z M48 116 Q56 111 66 116 L66 171 Q57 180 49 171 Z')}
        ${part('adductors', 'M42 116 L49 116 L50 157 L44 161 Z')}
        ${part('calves', 'M28 177 Q36 172 42 177 L39 219 L30 219 Z M51 177 Q58 172 65 177 L62 219 L53 219 Z')}
      </g>
      <g transform="translate(183 10)">
        <circle class="body-outline" cx="46" cy="15" r="14"/>
        ${part('upper_traps', 'M32 39 L46 32 L60 39 L57 53 L35 53 Z')}
        ${part('rear_delts', 'M20 44 Q11 52 11 67 L22 70 L30 48 Z M62 48 L70 70 L81 67 Q81 52 72 44 Z')}
        ${part('mid_back', 'M31 45 L61 45 L61 78 Q46 87 31 78 Z')}
        ${part('lats', 'M26 56 L33 55 L33 87 L26 102 L20 92 Z M59 55 L66 56 L72 92 L66 102 L59 87 Z')}
        ${part('erectors', 'M41 56 L51 56 L53 111 L39 111 Z')}
        ${part('glutes', 'M27 106 Q46 98 65 106 L65 131 Q46 140 27 131 Z')}
        ${part('hamstrings', 'M27 134 Q36 130 44 134 L43 174 Q35 180 27 173 Z M48 134 Q56 130 65 134 L65 173 Q57 180 49 174 Z')}
        ${part('abductors', 'M23 108 L30 106 L30 132 L23 128 Z M62 106 L69 108 L69 128 L62 132 Z')}
        ${part('calves', 'M28 178 Q36 173 42 178 L39 219 L30 219 Z M51 178 Q58 173 65 178 L62 219 L53 219 Z')}
      </g>
    </svg>`;
}
