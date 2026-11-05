/**
 * dsh-pf-stream 的浏览器半：插件详情页的语音转写设置面板 + 启用后的引导卡。
 *
 * 通信：走宿主 webServer 上的同源 HTTP 路由（/dsh-pf-stream/api/*）。
 * 持久 bundle 的浏览器半只有 fetch 可用；iframe 拿不到主题与语言，因此这里
 * 是纯 React 组件 + 宿主 slot。
 *
 * 约束：不能 require 任何 Harness 客户端包（版本会漂移），控件与样式自带，
 * 颜色只用 --dsw-alias-* 主题变量。
 */

window.__ModuleLoader__.load({
  id: 'dsh-pf-stream',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-pf-stream';
    const API = '/dsh-pf-stream/api';

    const ZH = {
      panelTitle: '语音识别与转写',
      panelSubtitle:
        '以下设置用于启用语音识别与转写。未配置时不影响视频播放，但不会生成转写文本；完成配置后，可对含有效音轨的视频进行转写。',
      refresh: '刷新',
      github: '在 GitHub 上查看源码',
      checking: '正在读取状态…',
      ffmpeg: '视频解码',
      ffmpegOk: '已就绪',
      ffmpegMissing: '待安装',
      ffmpegHint: '视频解码需要 ffmpeg 与 ffprobe。可在「高级」中填写可执行文件路径，或将其加入系统 PATH。',
      local: '本地转写',
      localReady: '已就绪',
      localMissing: '待安装',
      localHint: '本地转写音频仅在本机处理。',
      cloud: '云端转写',
      cloudReady: '已配置密钥',
      cloudMissing: '待配置',
      cloudHint: '云端转写只发送音频片段。',
      install: '下载本地模型',
      reinstall: '重新下载本地模型',
      installSize: 'small · 约 190 MB · 仅需下载一次',
      installedHint: '本地模型已就绪。',
      installing: '正在安装',
      cancel: '取消',
      verify: '测试转写',
      verifying: '正在验证…',
      verifyHint: '使用一段测试音频验证引擎是否可用。',
      verifyOk: '验证通过',
      cloudSection: '云端转写密钥',
      preset: '服务商',
      baseUrl: '接口地址',
      modelName: '模型名',
      apiKey: 'API Key',
      keyPlaceholder: '粘贴密钥；保存后仅显示“已配置”',
      save: '保存',
      clear: '清除',
      saved: '已保存',
      cleared: '已清除',
      keyNote: '密钥保存在本机凭据库，配置文件中仅保留引用。',
      getKey: '获取密钥 ↗',
      advanced: '高级',
      engine: '引擎选择',
      engineAuto: '自动（推荐）',
      engineLocal: '仅本地',
      engineCloud: '仅云端',
      engineOff: '不转写',
      engineHint: '自动：云端配置完整时用云端（更快，按量计费）；否则用本地模型。',
      language: '语言',
      languageAuto: '自动识别',
      modelSize: '本地模型大小',
      recommended: '推荐',
      threads: 'CPU 线程数（0 为自动）',
      cache: '转写缓存',
      clearCache: '清理转写缓存',
      activeLocal: '本地',
      activeCloud: '云端',
      activeNone: '未启用',
      cacheCleared: '缓存已清理',
      settingsReadonly: '该配置由宿主管理，请在配置文件中修改。',
      badgeReady: '转写可用',
      badgePending: '待完成配置',
      activationReady: '转写引擎已可用。',
      activationTitle: '启用语音转写',
      activationBody: '请选择转写方式：下载本地模型（约 190 MB），或配置云端服务商密钥。',
      activationInstall: '下载并启用本地模型',
      openSettings: '打开设置',
      later: '稍后再说',
      privacy: '本地转写音频仅在本机处理；云端转写只发送音频片段。',
      loadFailed: '读取状态失败',
      installStarted: '下载已开始',
      waitDownload: '下载在后台进行，画面处理照常。',
    };

    const EN = {
      panelTitle: 'Speech recognition and transcription',
      panelSubtitle:
        'These settings enable speech recognition and transcription. Without them, video playback is unaffected, but no transcript is generated. Once configured, videos with a usable audio track can be transcribed.',
      refresh: 'Refresh',
      github: 'View source on GitHub',
      checking: 'Reading status…',
      ffmpeg: 'Video decoding',
      ffmpegOk: 'Ready',
      ffmpegMissing: 'To install',
      ffmpegHint: 'Video decoding requires ffmpeg and ffprobe. Set their paths under Advanced, or add them to the system PATH.',
      local: 'Local transcription',
      localReady: 'Ready',
      localMissing: 'To install',
      localHint: 'Local transcription processes audio on this machine only.',
      cloud: 'Cloud transcription',
      cloudReady: 'Key configured',
      cloudMissing: 'To configure',
      cloudHint: 'Cloud transcription sends only audio slices.',
      install: 'Download local model',
      reinstall: 'Download the local model again',
      installSize: 'small · ~190 MB · one-time download',
      installedHint: 'The local model is ready.',
      installing: 'Installing',
      cancel: 'Cancel',
      verify: 'Test transcription',
      verifying: 'Testing…',
      verifyHint: 'Runs a short test tone through the engine.',
      verifyOk: 'Verified',
      cloudSection: 'Cloud transcription key',
      preset: 'Provider',
      baseUrl: 'Endpoint',
      modelName: 'Model',
      apiKey: 'API key',
      keyPlaceholder: 'Paste a key; only “configured” is shown afterwards',
      save: 'Save',
      clear: 'Clear',
      saved: 'Saved',
      cleared: 'Cleared',
      keyNote: 'The key is stored in the local credential store; the config file holds a reference only.',
      getKey: 'Get a key ↗',
      advanced: 'Advanced',
      engine: 'Engine',
      engineAuto: 'Auto (recommended)',
      engineLocal: 'Local only',
      engineCloud: 'Cloud only',
      engineOff: 'No transcription',
      engineHint: 'Auto: use the cloud when fully configured (faster, billed per use); otherwise the local model.',
      language: 'Language',
      languageAuto: 'Detect automatically',
      modelSize: 'Local model size',
      recommended: 'recommended',
      threads: 'CPU threads (0 = auto)',
      cache: 'Transcript cache',
      clearCache: 'Clear transcript cache',
      activeLocal: 'Local',
      activeCloud: 'Cloud',
      activeNone: 'Off',
      cacheCleared: 'Cache cleared',
      settingsReadonly: 'This config is managed by the host; edit the config file instead.',
      badgeReady: 'Transcription ready',
      badgePending: 'Setup incomplete',
      activationReady: 'The transcription engine is ready.',
      activationTitle: 'Enable speech transcription',
      activationBody: 'Choose a transcription path: download the local model (~190 MB), or configure a cloud provider key.',
      activationInstall: 'Download and enable the local model',
      openSettings: 'Open settings',
      later: 'Later',
      privacy: 'Local transcription processes audio on this machine only; cloud transcription sends only audio slices.',
      loadFailed: 'Failed to read status',
      installStarted: 'Download started',
      waitDownload: 'The download runs in the background; video processing continues.',
    };

    function detectLang() {
      try {
        return String(navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    }

    function makeTranslator(locale) {
      const lang = detectLang();
      const own = lang === 'zh' ? ZH : EN;
      let bound;
      try {
        if (locale && typeof locale.bind === 'function') bound = locale.bind(NS);
      } catch {
        bound = undefined;
      }
      return function t(key) {
        if (typeof bound === 'function') {
          try {
            const value = bound(key);
            if (typeof value === 'string' && value !== '') return value;
          } catch {
            // 回退到自带词典
          }
        }
        return own[key] || key;
      };
    }

    async function call(path, body) {
      const init =
        body === undefined
          ? { headers: { accept: 'application/json' } }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(body),
            };
      const response = await fetch(API + path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || (payload && payload.ok === false)) {
        const error = new Error(
          (payload && (payload.message || payload.error)) || 'HTTP ' + response.status,
        );
        error.code = payload && payload.error;
        throw error;
      }
      return payload && payload.data !== undefined ? payload.data : payload;
    }

    function mb(bytes) {
      if (!bytes || bytes <= 0) return '0 MB';
      return (bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1) + ' MB';
    }

    function engineName(id) {
      if (id === 'managed') return 'whisper.cpp';
      if (id === 'whisper_cpp') return 'whisper.cpp';
      if (id === 'whisper_ctranslate2') return 'faster-whisper';
      if (id === 'openai_whisper') return 'openai-whisper';
      return id || '';
    }

    const PALETTE = {
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      sub: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
      strongBorder: 'var(--dsw-alias-border-l2, rgba(127,127,127,.4))',
      card: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
      nested: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))',
      brand: 'var(--dsw-alias-brand-primary, #2f6fed)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #9a6700)',
      error: 'var(--dsw-alias-state-error-primary, #c62828)',
      idle: 'var(--dsw-alias-state-idle-primary, #8b949e)',
      glass: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 58%, transparent)',
      glassStrong: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 76%, transparent)',
      hairline: 'color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)',
      blur: 'blur(24px) saturate(140%)',
    };

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, color: PALETTE.text, fontSize: 13, lineHeight: 1.5 },
      headerRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 14, fontWeight: 600, margin: 0, letterSpacing: 0.1 },
      subtitle: { color: PALETTE.sub, fontSize: 12, margin: 0, lineHeight: 1.5 },
      cards: { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' },
      card: {
        border: '.5px solid ' + PALETTE.hairline,
        borderRadius: 14,
        background: PALETTE.glass,
        backdropFilter: PALETTE.blur,
        WebkitBackdropFilter: PALETTE.blur,
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      },
      cardTop: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: PALETTE.sub, letterSpacing: 0.2 },
      state: { fontWeight: 600, fontSize: 13, color: PALETTE.text },
      hint: {
        color: PALETTE.sub,
        fontSize: 12,
        lineHeight: 1.45,
        margin: 0,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        wordBreak: 'break-all',
      },
      dot: { width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flex: 'none' },
      button: {
        appearance: 'none',
        border: '.5px solid ' + PALETTE.hairline,
        background: PALETTE.glassStrong,
        color: PALETTE.text,
        borderRadius: 9,
        height: 30,
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      },
      iconButton: {
        appearance: 'none',
        border: '.5px solid ' + PALETTE.hairline,
        background: PALETTE.glassStrong,
        color: PALETTE.sub,
        borderRadius: 9,
        width: 30,
        height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        textDecoration: 'none',
        flex: 'none',
      },
      primary: {
        appearance: 'none',
        border: '.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent)',
        color: PALETTE.text,
        borderRadius: 9,
        height: 30,
        padding: '0 14px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      },
      danger: {
        appearance: 'none',
        border: '.5px solid ' + PALETTE.hairline,
        background: 'transparent',
        color: PALETTE.error,
        borderRadius: 9,
        height: 30,
        padding: '0 12px',
        fontSize: 12,
        cursor: 'pointer',
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      rowEnd: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' },
      grow: { flex: '1 1 160px', minWidth: 0 },
      label: { fontSize: 11, color: PALETTE.sub, display: 'block', marginBottom: 5, letterSpacing: 0.2 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '.5px solid ' + PALETTE.hairline,
        background: PALETTE.glass,
        color: PALETTE.text,
        borderRadius: 9,
        height: 32,
        padding: '0 10px',
        fontSize: 13,
        outline: 'none',
      },
      selectRoot: { position: 'relative' },
      selectTrigger: {
        width: '100%',
        boxSizing: 'border-box',
        border: '.5px solid ' + PALETTE.hairline,
        background: PALETTE.glass,
        color: PALETTE.text,
        borderRadius: 9,
        height: 32,
        padding: '0 10px',
        fontSize: 13,
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        cursor: 'pointer',
        textAlign: 'left',
      },
      selectTriggerOpen: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)',
      },
      selectValue: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chevron: {
        flex: '0 0 auto',
        width: 6,
        height: 6,
        borderRight: '1.5px solid ' + PALETTE.sub,
        borderBottom: '1.5px solid ' + PALETTE.sub,
        transform: 'rotate(45deg) translateY(-2px)',
        transition: 'transform .16s ease',
      },
      chevronOpen: { transform: 'rotate(-135deg) translateY(-2px)' },
      selectMenu: {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        right: 0,
        zIndex: 40,
        padding: 4,
        borderRadius: 10,
        border: '.5px solid ' + PALETTE.hairline,
        background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 92%, transparent)',
        backdropFilter: PALETTE.blur,
        WebkitBackdropFilter: PALETTE.blur,
        boxShadow: '0 12px 32px rgba(0, 0, 0, .38)',
        maxHeight: 240,
        overflowY: 'auto',
      },
      selectOption: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '7px 9px',
        borderRadius: 7,
        fontSize: 13,
        color: PALETTE.text,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      selectOptionHover: { background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)' },
      selectOptionActive: { background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)' },
      selectCheck: { color: PALETTE.sub, fontSize: 12 },
      section: {
        border: '.5px solid ' + PALETTE.hairline,
        borderRadius: 14,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: PALETTE.glass,
        backdropFilter: PALETTE.blur,
        WebkitBackdropFilter: PALETTE.blur,
      },
      sectionTitle: { fontSize: 12, fontWeight: 600, margin: 0, color: PALETTE.text },
      progressTrack: {
        height: 6,
        borderRadius: 999,
        background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)',
        overflow: 'hidden',
        flex: '1 1 auto',
        minWidth: 120,
      },
      progressFill: { height: '100%', background: PALETTE.brand, transition: 'width .3s ease', borderRadius: 999 },
      badge: {
        fontSize: 11,
        color: PALETTE.sub,
        border: '.5px solid ' + PALETTE.hairline,
        borderRadius: 999,
        padding: '2px 9px',
        whiteSpace: 'nowrap',
        background: PALETTE.glass,
      },
      notice: { fontSize: 12, color: PALETTE.ok },
      errorText: { fontSize: 12, color: PALETTE.error, margin: 0 },
      privacy: { fontSize: 11, color: PALETTE.sub, lineHeight: 1.6, margin: 0 },
      details: {
        border: '.5px solid ' + PALETTE.hairline,
        borderRadius: 14,
        padding: '12px 16px',
        background: PALETTE.glass,
        backdropFilter: PALETTE.blur,
        WebkitBackdropFilter: PALETTE.blur,
      },
      summary: { cursor: 'pointer', fontSize: 12, fontWeight: 600, color: PALETTE.text, listStyle: 'revert' },
      grid2: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
      activation: {
        border: '.5px solid ' + PALETTE.hairline,
        borderRadius: 14,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: PALETTE.glass,
        backdropFilter: PALETTE.blur,
        WebkitBackdropFilter: PALETTE.blur,
      },
    };

    function Dot(props) {
      return h('span', {
        style: Object.assign({}, styles.dot, { background: props.color }),
        'aria-hidden': true,
      });
    }

    function btnStyle(base, disabled) {
      return Object.assign({}, base, {
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      });
    }

    function StatusCard(props) {
      return h(
        'div',
        { style: styles.card },
        h('div', { style: styles.cardTop }, h(Dot, { color: props.color }), props.label),
        h('div', { style: styles.state }, props.state),
        props.hint ? h('p', { style: styles.hint, title: props.hint }, props.hint) : null,
      );
    }

    function Progress(props) {
      const job = props.job;
      const total = job && job.total ? job.total : 0;
      const received = job && job.received ? job.received : 0;
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      return h(
        'div',
        { style: styles.section },
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.sectionTitle }, props.t('installing')),
          h('div', { style: styles.progressTrack },
            h('div', { style: Object.assign({}, styles.progressFill, { width: percent + '%' }) }),
          ),
          h('span', { style: styles.badge }, total > 0 ? mb(received) + ' / ' + mb(total) : mb(received)),
        ),
        h('p', { style: styles.hint }, (job && job.message) || ''),
        h(
          'div',
          { style: styles.row },
          h('button', { type: 'button', style: styles.danger, onClick: props.onCancel }, props.t('cancel')),
          h('span', { style: styles.hint }, props.t('waitDownload')),
        ),
      );
    }

    function SelectField(props) {
      const options = props.options || [];
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(-1);
      const rootRef = React.useRef(null);
      const selectedIndex = options.findIndex(function (item) { return item.value === props.value; });
      const current = selectedIndex >= 0 ? options[selectedIndex] : options[0];

      React.useEffect(function () {
        if (!open) return undefined;
        function close(event) {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        }
        document.addEventListener('mousedown', close);
        return function () { document.removeEventListener('mousedown', close); };
      }, [open]);

      function commit(index) {
        const option = options[index];
        if (!option) return;
        setOpen(false);
        if (option.value !== props.value) props.onChange(option.value);
      }

      function onTriggerKey(event) {
        if (event.key === 'Escape') { setOpen(false); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) { setOpen(true); setHover(Math.max(0, selectedIndex)); return; }
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setHover(function (previous) {
            const from = previous < 0 ? selectedIndex : previous;
            return Math.min(options.length - 1, Math.max(0, from + step));
          });
          return;
        }
        if ((event.key === 'Enter' || event.key === ' ') && open) {
          event.preventDefault();
          commit(hover >= 0 ? hover : selectedIndex);
        }
      }

      return h(
        'div',
        { style: styles.selectRoot, ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            style: Object.assign({}, styles.selectTrigger, open ? styles.selectTriggerOpen : null),
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            onClick: function () {
              setOpen(!open);
              if (!open) setHover(Math.max(0, selectedIndex));
            },
            onKeyDown: onTriggerKey,
          },
          h('span', { style: styles.selectValue }, current ? current.label : ''),
          h('span', { style: Object.assign({}, styles.chevron, open ? styles.chevronOpen : null) }),
        ),
        open
          ? h(
              'div',
              { style: styles.selectMenu, role: 'listbox' },
              options.map(function (item, index) {
                return h(
                  'div',
                  {
                    key: item.value,
                    role: 'option',
                    'aria-selected': item.value === props.value,
                    style: Object.assign(
                      {},
                      styles.selectOption,
                      index === hover ? styles.selectOptionHover : null,
                      item.value === props.value ? styles.selectOptionActive : null,
                    ),
                    onMouseEnter: function () { setHover(index); },
                    onMouseDown: function (event) { event.preventDefault(); },
                    onClick: function () { commit(index); },
                  },
                  h('span', null, item.label),
                  item.value === props.value ? h('span', { style: styles.selectCheck }, '✓') : null,
                );
              }),
            )
          : null,
      );
    }

    function useStatus() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const load = React.useCallback(async function () {
        try {
          const data = await call('/status');
          setStatus(data);
          setError('');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);
      React.useEffect(function () {
        let alive = true;
        let timer = null;
        async function tick() {
          if (!alive) return;
          await load();
          if (!alive) return;
          const busy = status && status.install &&
            ['preparing', 'downloading', 'verifying', 'extracting'].indexOf(status.install.phase) >= 0;
          timer = setTimeout(tick, busy ? 1000 : 6000);
        }
        void tick();
        return function () {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [load]);
      return { status, error, reload: load };
    }

    function Panel(props) {
      const t = props.t;
      const state = useStatus();
      const [notice, setNotice] = React.useState('');
      const [failure, setFailure] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [keyDraft, setKeyDraft] = React.useState('');
      const [customBase, setCustomBase] = React.useState('');
      const [customModel, setCustomModel] = React.useState('');
      const [openedAdvanced, setOpenedAdvanced] = React.useState(false);

      const status = state.status;

      React.useEffect(function () {
        if (!status) return;
        setCustomBase(status.cloud.baseUrl || '');
        setCustomModel(status.cloud.model || '');
      }, [status && status.cloud && status.cloud.preset]);

      function run(name, action) {
        setBusy(name);
        setFailure('');
        setNotice('');
        return Promise.resolve()
          .then(action)
          .then(function (data) {
            if (typeof data === 'string' && data !== '') setNotice(data);
            return state.reload();
          })
          .catch(function (cause) {
            setFailure(cause instanceof Error ? cause.message : String(cause));
          })
          .then(function () {
            setBusy('');
          });
      }

      if (!status) {
        return h(
          'div',
          { style: styles.root },
          h('p', { style: styles.hint }, state.error ? t('loadFailed') + '：' + state.error : t('checking')),
        );
      }

      const ffmpeg = status.ffmpeg || {};
      const localReady = status.engine && status.engine.ready;
      const cloudReady = status.cloud && status.cloud.keyConfigured && status.cloud.baseUrl && status.cloud.model;
      const ready = ffmpeg.available && (localReady || cloudReady);
      const job = status.install;
      const installing =
        job && ['preparing', 'downloading', 'verifying', 'extracting'].indexOf(job.phase) >= 0;
      const preset = status.cloud.preset;
      const custom = status.cloud.editable;
      const activeKind = status.active
        ? status.active.kind
        : status.mode === 'local'
          ? 'local'
          : status.mode === 'cloud'
            ? 'cloud'
            : cloudReady
              ? 'cloud'
              : localReady
                ? 'local'
                : 'none';
      const activeLabel =
        activeKind === 'local' ? t('activeLocal') : activeKind === 'cloud' ? t('activeCloud') : t('activeNone');

      const engineModes = [
        ['auto', t('engineAuto')],
        ['local', t('engineLocal')],
        ['cloud', t('engineCloud')],
        ['off', t('engineOff')],
      ];

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.headerRow },
          h('h3', { style: styles.title }, t('panelTitle')),
          h('span', { style: styles.badge }, ready ? t('badgeReady') + ' · ' + activeLabel : t('badgePending')),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'a',
            {
              href: 'https://github.com/Weilv-D/dsh-pf-stream',
              target: '_blank',
              rel: 'noreferrer',
              title: t('github'),
              'aria-label': t('github'),
              style: styles.iconButton,
            },
            h(
              'svg',
              { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': 'true' },
              h('path', {
                d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z',
              }),
            ),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, onClick: function () { void state.reload(); } },
            t('refresh'),
          ),
        ),
        h('p', { style: styles.subtitle }, t('panelSubtitle')),

        h(
          'div',
          { style: styles.cards },
          h(StatusCard, {
            label: t('ffmpeg'),
            state: ffmpeg.available ? t('ffmpegOk') : t('ffmpegMissing'),
            color: ffmpeg.available ? PALETTE.ok : PALETTE.error,
            hint: ffmpeg.available ? ffmpeg.ffmpeg : t('ffmpegHint'),
          }),
          h(StatusCard, {
            label: t('local'),
            state: localReady ? t('localReady') + ' · ' + engineName(status.engine.engine) : t('localMissing'),
            color: localReady ? PALETTE.ok : PALETTE.idle,
            hint: localReady
              ? status.engine.modelPath || t('localHint')
              : status.engine.reason || t('localHint'),
          }),
          h(StatusCard, {
            label: t('cloud'),
            state: cloudReady ? t('cloudReady') : t('cloudMissing'),
            color: cloudReady ? PALETTE.ok : PALETTE.idle,
            hint: (status.cloud.label || '') + (cloudReady ? ' · ' + status.cloud.model : ' · ' + t('cloudHint')),
          }),
        ),

        installing
          ? h(Progress, {
              t: t,
              job: job,
              onCancel: function () {
                void run('cancel', function () {
                  return call('/install/cancel', {});
                });
              },
            })
          : h(
              'div',
              { style: styles.row },
              h(
                'button',
                {
                  type: 'button',
                  style: btnStyle(localReady ? styles.button : styles.primary, busy !== ''),
                  disabled: busy !== '',
                  onClick: function () {
                    void run('install', function () {
                      return call('/install', { target: 'all' }).then(function () {
                        return t('installStarted');
                      });
                    });
                  },
                },
                busy === 'install' ? t('installing') + '…' : localReady ? t('reinstall') : t('install'),
              ),
              h('span', { style: styles.hint }, localReady ? t('installedHint') : t('installSize')),
            ),

        h(
          'div',
          { style: styles.row },
          h(
            'button',
            {
              type: 'button',
              style: btnStyle(styles.button, busy !== '' || (!localReady && !cloudReady)),
              onClick: function () {
                void run('test', function () {
                  return call('/test', {}).then(function (result) {
                    return (result.ok ? t('verifyOk') : result.message) +
                      ' · ' + (result.engine || '') + ' · ' + (result.latencyMs || 0) + 'ms';
                  });
                });
              },
            },
            busy === 'test' ? t('verifying') : t('verify'),
          ),
          h('span', { style: styles.hint }, t('verifyHint')),
        ),

        notice ? h('p', { style: styles.notice }, notice) : null,
        failure ? h('p', { style: styles.errorText }, failure) : null,

        h(
          'div',
          { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('cloudSection')),
          h(
            'div',
            { style: styles.row },
            h('div', { style: styles.grow },
              h('label', { style: styles.label }, t('preset')),
              h(SelectField, {
                value: preset,
                options: (status.presets || []).map(function (item) {
                  return { value: item.id, label: item.label };
                }),
                onChange: function (value) {
                  void run('preset', function () {
                    return call('/config', { field: 'preset', value: value });
                  });
                },
              }),
            ),
            custom
              ? h('div', { style: styles.grow },
                  h('label', { style: styles.label }, t('baseUrl')),
                  h('input', {
                    style: styles.input,
                    value: customBase,
                    placeholder: 'https://api.example.com',
                    onChange: function (event) { setCustomBase(event.target.value); },
                    onBlur: function () {
                      void run('baseUrl', function () {
                        return call('/config', { field: 'baseUrl', value: customBase });
                      });
                    },
                  }),
                )
              : null,
            custom
              ? h('div', { style: styles.grow },
                  h('label', { style: styles.label }, t('modelName')),
                  h('input', {
                    style: styles.input,
                    value: customModel,
                    placeholder: 'whisper-1',
                    onChange: function (event) { setCustomModel(event.target.value); },
                    onBlur: function () {
                      void run('model', function () {
                        return call('/config', { field: 'model', value: customModel });
                      });
                    },
                  }),
                )
              : null,
          ),
          h(
            'div',
            { style: styles.rowEnd },
            h('div', { style: styles.grow },
              h('label', { style: styles.label }, t('apiKey')),
              h('input', {
                style: styles.input,
                type: 'password',
                value: keyDraft,
                placeholder: t('keyPlaceholder'),
                autoComplete: 'off',
                onChange: function (event) { setKeyDraft(event.target.value); },
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, styles.primary, {
                  opacity: busy !== '' || keyDraft.trim() === '' ? 0.45 : 1,
                  cursor: busy !== '' || keyDraft.trim() === '' ? 'default' : 'pointer',
                }),
                disabled: busy !== '' || keyDraft.trim() === '',
                onClick: function () {
                  void run('key', function () {
                    return call('/key', { preset: preset, key: keyDraft }).then(function () {
                      setKeyDraft('');
                      return t('saved');
                    });
                  });
                },
              },
              t('save'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: styles.button,
                disabled: busy !== '',
                onClick: function () {
                  void run('key', function () {
                    return call('/key', { preset: preset, key: '' }).then(function () {
                      setKeyDraft('');
                      return t('cleared');
                    });
                  });
                },
              },
              t('clear'),
            ),
            status.cloud.keyUrl
              ? h('a', {
                  href: status.cloud.keyUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { fontSize: 12, color: PALETTE.brand, textDecoration: 'none', paddingBottom: 8 },
                }, t('getKey'))
              : null,
          ),
          h('p', { style: styles.hint }, t('keyNote')),
        ),

        h(
          'details',
          {
            style: styles.details,
            open: openedAdvanced,
            onToggle: function (event) { setOpenedAdvanced(event.target.open); },
          },
          h('summary', { style: styles.summary }, t('advanced')),
          h('p', { style: Object.assign({}, styles.hint, { margin: '6px 0 0' }) }, t('engineHint')),
          h(
            'div',
            { style: Object.assign({}, styles.grid2, { marginTop: 10 }) },
            h('div', null,
              h('label', { style: styles.label }, t('engine')),
              h(SelectField, {
                value: (status.config && status.config.engine) || status.mode || 'auto',
                options: engineModes.map(function (item) {
                  return { value: item[0], label: item[1] };
                }),
                onChange: function (value) {
                  void run('engine', function () {
                    return call('/config', { field: 'engine', value: value });
                  });
                },
              }),
            ),
            h('div', null,
              h('label', { style: styles.label }, t('language')),
              h('input', {
                style: styles.input,
                defaultValue: (status.config && status.config.language) || '',
                placeholder: t('languageAuto'),
                onBlur: function (event) {
                  const value = event.target.value;
                  void run('language', function () {
                    return call('/config', { field: 'language', value: value });
                  });
                },
              }),
            ),
            h('div', null,
              h('label', { style: styles.label }, t('modelSize')),
              h(SelectField, {
                value: (status.config && status.config.modelId) || status.modelId,
                options: [['base-q5_1', 'base · 60 MB'], ['small-q5_1', 'small · 190 MB'], ['medium-q5_0', 'medium · 540 MB']].map(
                  function (item) {
                    const label = item[1] + (item[0] === 'small-q5_1' ? ' · ' + t('recommended') : '');
                    return { value: item[0], label: label };
                  },
                ),
                onChange: function (value) {
                  void run('modelId', function () {
                    return call('/config', { field: 'modelId', value: value });
                  });
                },
              }),
            ),
            h('div', null,
              h('label', { style: styles.label }, t('threads')),
              h('input', {
                style: styles.input,
                type: 'number',
                min: 0,
                max: 32,
                defaultValue: (status.config && status.config.threads) || 0,
                onBlur: function (event) {
                  const value = Number(event.target.value || 0);
                  void run('threads', function () {
                    return call('/config', { field: 'threads', value: value });
                  });
                },
              }),
            ),
            h('div', null,
              h('label', { style: styles.label }, t('cache')),
              h('div', { style: styles.hint }, mb(status.cacheBytes) + ' · ' + status.cacheDir),
              h(
                'button',
                {
                  type: 'button',
                  style: Object.assign({}, styles.button, { marginTop: 6 }),
                  disabled: busy !== '',
                  onClick: function () {
                    void run('clearCache', function () {
                      return call('/cache/clear', {}).then(function () { return t('cacheCleared'); });
                    });
                  },
                },
                t('clearCache'),
              ),
            ),
          ),
          status.configWritable ? null : h('p', { style: styles.hint }, t('settingsReadonly')),
        ),

        h('p', { style: styles.privacy }, t('privacy')),
      );
    }

    function Activation(props) {
      const t = props.t || makeTranslator(undefined);
      const state = useStatus();
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState('');
      const status = state.status;
      const job = status && status.install;
      const installing =
        job && ['preparing', 'downloading', 'verifying', 'extracting'].indexOf(job.phase) >= 0;
      const ready = status && (status.ready || (status.engine && status.engine.ready));

      function install() {
        setBusy(true);
        setFailure('');
        call('/install', { target: 'all' })
          .then(function () { return state.reload(); })
          .catch(function (cause) {
            setFailure(cause instanceof Error ? cause.message : String(cause));
          })
          .then(function () { setBusy(false); });
      }

      return h(
        'div',
        { style: styles.activation },
        h('strong', { style: { fontSize: 14 } }, t('activationTitle')),
        h('p', { style: styles.hint }, ready ? t('activationReady') : t('activationBody')),
        installing
          ? h(Progress, {
              t: t,
              job: job,
              onCancel: function () { void call('/install/cancel', {}).then(state.reload); },
            })
          : h(
              'div',
              { style: styles.row },
              ready
                ? null
                : h(
                    'button',
                    { type: 'button', style: styles.primary, disabled: busy, onClick: install },
                    busy ? t('installing') + '…' : t('activationInstall'),
                  ),
              h(
                'button',
                { type: 'button', style: styles.button, onClick: props.onOpenDetails },
                t('openSettings'),
              ),
              h(
                'button',
                { type: 'button', style: styles.button, onClick: props.onDismiss },
                t('later'),
              ),
            ),
        failure ? h('p', { style: styles.errorText }, failure) : null,
      );
    }

    function safeApply(ctx, run) {
      try {
        run();
      } catch (error) {
        try {
          console.error('[dsh-pf-stream] client apply failed', error);
        } catch {
          // 控制台不可用时保持安静
        }
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        try {
          if (locale && typeof locale.register === 'function') {
            locale.register(NS, { zh: ZH, en: EN });
          }
        } catch {
          // 没有 locale 服务时用自带词典
        }
        const t = makeTranslator(locale);

        safeApply(ctx, function () {
          ctx.slots.inject('plugins.bundle.config', function () {
            return ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: 'dsh-pf-stream',
                locale: NS,
                inject: function () { return { t: t }; },
              },
              function (ownerProps) {
                if (!ownerProps || ownerProps.view === 'summary') return null;
                return h(Panel, { t: t });
              },
            );
          });
        });

        safeApply(ctx, function () {
          ctx.slots.inject('plugins.bundle.activation', function () {
            return ctx.slots.register(
              {
                name: 'plugins.bundle.activation',
                key: 'dsh-pf-stream',
                locale: NS,
                inject: function () { return { t: t }; },
              },
              function (ownerProps) {
                const props = ownerProps || {};
                return h(Activation, {
                  t: t,
                  onDismiss: typeof props.onDismiss === 'function' ? props.onDismiss : function () {},
                  onOpenDetails:
                    typeof props.onOpenDetails === 'function' ? props.onOpenDetails : function () {},
                });
              },
            );
          });
        });
      },
    };
  },
});
