/**
 * 食材の賞味期限リーダー（MVP①）
 * LINE に写真を送る → Claude Vision で賞味期限を読み取る → LINE で返信する
 *
 * 前提: スクリプトプロパティに以下を設定しておくこと
 *   LINE_CHANNEL_ACCESS_TOKEN : LINE Developers の長期チャネルアクセストークン
 *   ANTHROPIC_API_KEY         : Anthropic コンソールで発行した API キー
 *   ALLOWED_USER_ID           : (任意) 自分の LINE userId。設定すると他人からの投稿を無視する
 */

/**
 * 使用するモデル。安い順に haiku < sonnet < opus。
 *   'claude-opus-5'    約3円/枚   精度最優先
 *   'claude-sonnet-5'  約1.1円/枚 バランス型
 *   'claude-haiku-4-5' 約0.6円/枚 最安（effort 非対応のため自動で除外される）
 */
/**
 * タスクごとにモデルを分ける。
 *   写真の読み取りはかすれた印字を読む難しい仕事なので精度優先。
 *   テキストの解析と在庫の突き合わせは易しいので安いモデルで足りる。
 * 精度に不満が出たら MODEL_TEXT を 'claude-sonnet-5' や MODEL_VISION と同じものに上げる。
 */
var MODEL_VISION = 'claude-opus-5';    // 約$5/$10 per MTok
var MODEL_TEXT = 'claude-haiku-4-5';   // 約$1/$5 per MTok

var ANTHROPIC_MODEL = MODEL_VISION;    // testConfig の疎通確認用
var ANTHROPIC_VERSION = '2023-06-01';
var MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Claude の画像サイズ上限に対する安全マージン

// ---------------------------------------------------------------- スプレッドシート定義

var SHEET_NAME = '在庫';

// 列番号（1始まり）。順番を変えるときはヘッダーと合わせて直すこと。
var COL = {
  REGISTERED: 1,  // 登録日時
  NAME: 2,        // 食材名
  DATE: 3,        // 期限 (YYYY-MM-DD)
  PRECISION: 4,   // day / month
  LABEL: 5,       // 賞味期限 / 消費期限 / 不明
  CONFIDENCE: 6,  // high / medium / low
  SOURCE: 7,      // 写真 / テキスト
  RAW: 8,         // 原文（写真の印字、または発話の該当部分）
  STATUS: 9,      // 在庫 / 消費済 / 破棄 / 取消
  UPDATED: 10,    // 状態を最後に変えた日時
  NOTIFIED_1M: 11, // 残り1か月の通知を送った日
  NOTIFIED_1W: 12  // 残り1週間の通知を送った日
};
var COL_COUNT = 12;

var HEADERS = ['登録日時', '食材名', '期限', '精度', 'ラベル', '確度',
  '入力元', '原文', '状態', '更新日時', '通知1M', '通知1W'];

var STATUS = { STOCK: '在庫', USED: '消費済', DISCARDED: '破棄', CANCELED: '取消' };

// 通知のしきい値（日数）
var NOTIFY_1M_DAYS = 30;
var NOTIFY_1W_DAYS = 7;

// ---------------------------------------------------------------- 設定読み出し

function prop_(key, required) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) {
    throw new Error('スクリプトプロパティ ' + key + ' が未設定です');
  }
  return v;
}

// ---------------------------------------------------------------- Webhook 入口

/**
 * LINE Messaging API の Webhook 受け口。
 * 注意: GAS の doPost は HTTP ヘッダーを取得できないため X-Line-Signature の
 * 検証はできない。代わりに ALLOWED_USER_ID による送信者チェックで代用する。
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var events = body.events || [];
    for (var i = 0; i < events.length; i++) {
      handleEvent_(events[i]);
    }
  } catch (err) {
    console.error('doPost failed: ' + err.stack);
  }
  // LINE には常に 200 を返す（エラーを返すと再送され続けるため）
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleEvent_(event) {
  if (event.type !== 'message') return;

  var allowed = prop_('ALLOWED_USER_ID', false);
  if (allowed && event.source && event.source.userId !== allowed) {
    console.warn('許可外のユーザーからの投稿を無視: ' + event.source.userId);
    return;
  }

  var msg = event.message;

  if (msg.type === 'text') {
    handleText_(event, msg.text.trim());
    return;
  }

  if (msg.type === 'audio') {
    replyText_(event.replyToken,
      'ボイスメッセージには未対応です。\n'
      + 'キーボードのマイク（🌐 の隣）で音声入力して、文字にしてから送ってください。');
    return;
  }

  if (msg.type !== 'image') {
    replyText_(event.replyToken, '写真か、テキストで期限を送ってください。');
    return;
  }

  try {
    clearPending_(); // 写真が来たら選択待ちは打ち切る
    var image = fetchLineImage_(msg.id);
    var result = extractExpiry_(image.base64, image.mimeType);
    var items = (result && result.items) || [];
    if (!items.length) {
      replyText_(event.replyToken, PHOTO_EMPTY_MESSAGE);
      return;
    }
    replyText_(event.replyToken, registerItems_(items, '写真'));
  } catch (err) {
    console.error('画像処理に失敗: ' + err.stack);
    replyText_(event.replyToken, '読み取りに失敗しました。\n' + err.message);
  }
}

var HELP_MESSAGE = [
  '使い方',
  '',
  '■ 登録',
  '・賞味期限が写った写真を送る（複数商品まとめて可）',
  '・「豆乳は2027年2月21日 ヨーグルトは9月17日」と送る',
  '　「納豆は明日まで」のような言い方も可',
  '同じものが在庫にあると確認します。まとめ買いは',
  '「牛乳を2個 9月11日」と個数を言えば確認しません。',
  '',
  '■ 使ったとき',
  '「牛乳使った」「ヨーグルト食べた」',
  '「豆腐捨てた」（破棄として記録）',
  '同じ食材が複数あるときは、期限つきの候補を',
  '返すので番号で答えてください。',
  '',
  '■ 通知',
  '毎週土曜の朝、期限が近いものをお知らせします。',
  '1品につき残り1か月と残り1週間の2回だけです。',
  '',
  '■ コマンド',
  '在庫 … 在庫の一覧',
  '取消 … 直前の登録・消費を取り消す',
  'id … あなたの userId を表示'
].join('\n');

var PHOTO_EMPTY_MESSAGE = '食品を検出できませんでした。\n商品と期限の印字が写るように撮り直してみてください。';
var TEXT_EMPTY_MESSAGE = '食材と期限を読み取れませんでした。\n「豆乳は2027年2月21日」のように、食材名と日付を続けて送ってください。';

function handleText_(event, text) {
  // Claude を呼ばずに済む固定コマンドは先に処理する
  if (text === 'id') {
    replyText_(event.replyToken, 'あなたの userId:\n' + (event.source.userId || '(取得不可)'));
    return;
  }
  if (!text || text === 'ヘルプ' || text === 'help' || text === '使い方') {
    replyText_(event.replyToken, HELP_MESSAGE);
    return;
  }
  // 質問を返している最中なら、その回答として先に受ける
  var note = '';
  var pending = getPending_();
  if (pending) {
    if (isCancelWord_(text)) {
      replyText_(event.replyToken, cancelPending_());
      return;
    }
    var answer = pending.kind === 'register' ? parseRegisterAnswer_(text) : parseChoice_(text);
    if (answer !== null) {
      replyText_(event.replyToken, pending.kind === 'register'
        ? resolveRegister_(answer)
        : resolvePending_(answer));
      return;
    }
    // 回答と解釈できない入力が来たら質問を打ち切る。
    // 黙って捨てると「答えたのに無視された」ように見えるので、必ず断りを入れる。
    clearPending_();
    note = pending.kind === 'register'
      ? '（先ほどの重複確認は取り消しました。登録していません）\n\n'
      : '（先ほどの選択は取り消しました。記録は変えていません）\n\n';
  }

  if (text === '取消' || text === '取り消し' || text === 'とりけし') {
    replyText_(event.replyToken, note + undoLast_());
    return;
  }
  if (text === '在庫' || text === '一覧' || text === 'リスト') {
    replyText_(event.replyToken, note + listStock_());
    return;
  }

  // 「牛乳使った」のような単純な言い方は API を使わずに処理する
  var fast = parseConsumeFast_(text);
  if (fast) {
    try {
      replyText_(event.replyToken,
        note + consumeItems_([{ item_name: fast.item_name }], fast.disposed));
      return;
    } catch (err) {
      console.error('消費処理に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
      return;
    }
  }

  try {
    var result = parseTextExpiry_(text);
    var intent = (result && result.intent) || 'unknown';
    var items = (result && result.items) || [];

    if (intent === 'consume' || intent === 'discard') {
      replyText_(event.replyToken, note + consumeItems_(items, intent === 'discard'));
      return;
    }
    if (intent === 'register' && items.length) {
      replyText_(event.replyToken, note + registerItems_(items, 'テキスト'));
      return;
    }
    replyText_(event.replyToken, note + TEXT_EMPTY_MESSAGE);
  } catch (err) {
    console.error('テキスト処理に失敗: ' + err.stack);
    replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
  }
}

// ---------------------------------------------------------------- LINE API

/** メッセージ ID から画像バイナリを取得し base64 にする */
function fetchLineImage_(messageId) {
  var res = UrlFetchApp.fetch(
    'https://api-data.line.me/v2/bot/message/' + encodeURIComponent(messageId) + '/content',
    {
      method: 'get',
      headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() !== 200) {
    throw new Error('LINE から画像を取得できません (HTTP ' + res.getResponseCode() + ')');
  }

  var blob = res.getBlob();
  var bytes = blob.getBytes();
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('画像が大きすぎます (' + Math.round(bytes.length / 1024 / 1024 * 10) / 10 + 'MB)。'
      + 'カメラの解像度を下げるか、期限表示部分を拡大して撮り直してください。');
  }

  var mimeType = blob.getContentType() || 'image/jpeg';
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(mimeType) < 0) {
    mimeType = 'image/jpeg';
  }

  return { base64: Utilities.base64Encode(bytes), mimeType: mimeType };
}

/** 返信トークンでテキストを返す */
function replyText_(replyToken, text) {
  if (!replyToken) return;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text.substring(0, 4900) }]
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('LINE reply 失敗 (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
  }
}

// ---------------------------------------------------------------- Claude API

var ITEM_SCHEMA = {
  type: 'object',
  properties: {
    position: { type: 'string', description: '写真内の位置。例「左」「中央」「右奥」。1点しか写っていなければ空文字' },
    item_name: { type: 'string', description: 'ブランド名＋商品名のみ。内容量・型番・キャッチコピーは含めない。読み取れなければ空文字' },
    found: { type: 'boolean', description: 'この商品の期限表示を読み取れたか' },
    label: { type: 'string', description: '「賞味期限」「消費期限」「製造日」「不明」のいずれか' },
    date: { type: 'string', description: 'YYYY-MM-DD 形式。年月のみの表示ならその月の末日。読めなければ空文字' },
    date_precision: { type: 'string', description: '"day" | "month" | "none"' },
    raw_text: { type: 'string', description: '画像上の期限表示をそのまま書き写したもの' },
    confidence: { type: 'string', description: '"high" | "medium" | "low"' },
    note: { type: 'string', description: '判断に迷った点があれば日本語で1文。なければ空文字' }
  },
  required: ['position', 'item_name', 'found', 'label', 'date', 'date_precision', 'raw_text', 'confidence', 'note'],
  additionalProperties: false
};

var EXPIRY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: '写真に写っている食品ごとに1要素。写真の左から右の順に並べる',
      items: ITEM_SCHEMA
    }
  },
  required: ['items'],
  additionalProperties: false
};

var TEXT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    item_name: { type: 'string', description: '食材名。明らかな音声誤認識は妥当な食材名に訂正する。内容量や型番は含めない' },
    quantity: { type: 'number', description: '個数。「2個買った」のように明示された場合のみその数。述べられていなければ 1' },
    found: { type: 'boolean', description: 'この食材の期限を特定できたか' },
    label: { type: 'string', description: '「賞味期限」「消費期限」「不明」のいずれか。言及がなければ「不明」' },
    date: { type: 'string', description: 'YYYY-MM-DD 形式。特定できなければ空文字' },
    date_precision: { type: 'string', description: '"day" | "month" | "none"' },
    raw_text: { type: 'string', description: '入力文のうち、この食材に対応する部分をそのまま抜き出したもの' },
    confidence: { type: 'string', description: '"high" | "medium" | "low"' },
    note: { type: 'string', description: '訂正した内容や判断に迷った点を日本語で1文。なければ空文字' }
  },
  required: ['item_name', 'quantity', 'found', 'label', 'date', 'date_precision', 'raw_text', 'confidence', 'note'],
  additionalProperties: false
};

var TEXT_EXPIRY_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      description: '"register"（期限の登録）| "consume"（食べた・使った）| "discard"（捨てた）| "unknown"'
    },
    items: {
      type: 'array',
      description: '入力文に登場した食材ごとに1要素。登場順に並べる',
      items: TEXT_ITEM_SCHEMA
    }
  },
  required: ['intent', 'items'],
  additionalProperties: false
};

/** 今日の日付を「2026-09-06（日）」形式で返す */
function todayJst_() {
  var now = new Date();
  var ymd = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  var wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(ymd + 'T00:00:00+09:00').getDay()];
  return ymd + '（' + wd + '）';
}

function buildTextPrompt_(text) {
  return [
    'ユーザーが食材について口頭で述べた文を解析してください。',
    '',
    '今日は ' + todayJst_() + '（日本時間）です。',
    '',
    'まず intent を判定してください:',
    '- "register" … 食材の期限を登録しようとしている。例「豆乳は2027年2月21日」「納豆明日まで」',
    '- "consume"  … 食べた・使った・飲んだと報告している。例「牛乳使った」「ヨーグルト食べた」',
    '- "discard"  … 捨てた・処分したと報告している。例「豆腐捨てた」「傷んでたので処分した」',
    '- "unknown"  … 上記のいずれでもない、または食材が読み取れない',
    '',
    'consume / discard の場合は、対象の食材名だけを items に入れてください。',
    'その場合 date は空文字、found は false のままで構いません（日付が述べられていればその日付を入れてください）。',
    '',
    'register の場合は、以下に従って期限日を特定してください。',
    '',
    '入力文はスマートフォンの音声入力で作られている前提です。次の特徴を考慮してください。',
    '',
    '文の区切りについて:',
    '- 句読点がなく、複数の食材が切れ目なく続くことがあります。',
    '- 「次に」「そして」「あと」「それから」「えーと」などのつなぎ言葉やフィラーは区切りとして扱い、食材名には含めないでください。',
    '- 例:「豆乳は2027年2月21日次にヨーグルトは2026年9月17日そして生クリームは2026年9月14日」',
    '  → 豆乳=2027-02-21、ヨーグルト=2026-09-17、生クリーム=2026-09-14 の3件。',
    '  「日次に」を日付の一部と誤解しないこと。',
    '',
    '誤認識の訂正について:',
    '- 音声入力では同音異義語の誤変換が起こります。食材の文脈に照らして明らかにおかしい語は、妥当な食材名に訂正してください。',
    '  例:「投入」→「豆乳」、「牛乳」の誤変換としての「給料」、「納豆」→「何と」、「卵」→「玉子」（これは訂正不要）。',
    '- 訂正した場合は note に「『投入』を『豆乳』と解釈」のように記し、confidence を "medium" にしてください。',
    '- 食材名として解釈できるか自信が持てない場合も、item_name は最も可能性の高い食材名にし、confidence を "low" にしてください。',
    '- 言い直しがある場合は後に述べた方を採用してください。例:「牛乳は8月3日いや13日」→ 8月13日。',
    '- 内容量や個数を述べられても item_name には含めないでください。例:「牛乳1リットル」→「牛乳」。',
    '- 個数が明示された場合は quantity に入れてください。例:「牛乳を2個買った」→ quantity=2。',
    '  「2個」「2本」「2つ」「2パック」などが対象です。内容量（1リットル、400g）は個数ではないので quantity=1 のままにしてください。',
    '  個数が述べられていなければ quantity は 1 にしてください。',
    '',
    '日付の解釈について:',
    '- 年が省略された場合（例「9月17日」「8/3」）は、今日以降で最も近い年を補ってください。',
    '- 相対表現を解決してください。「今日」「明日」「明後日」「3日後」「今週末」「来週の水曜」「今月末」など。',
    '- 「〜まで」「〜が期限」などの言い回しは期限日を指します。',
    '- 「賞味期限」「消費期限」と明示された場合のみ label にその語を入れ、言及がなければ「不明」にしてください。',
    '- 月までしか述べられていない場合（例「10月くらい」）は、その月の末日を date に入れ date_precision を "month"、confidence を "low" にしてください。',
    '- 日付をまったく特定できない食材は、items から省かずに found を false、date を空文字で入れてください。推測で日付を作らないこと。',
    '',
    '食材と期限がひとつも読み取れない場合は、items を空の配列にしてください。',
    '',
    '--- 入力文 ---',
    text
  ].join('\n');
}

function buildPrompt_() {
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  return [
    '食品パッケージの写真から、写っているすべての商品について賞味期限または消費期限を読み取ってください。',
    '',
    '今日の日付は ' + today + '（日本時間）です。年が2桁の場合はこれを基準に西暦を補完してください。',
    '',
    '商品名（item_name）の書き方:',
    '- ブランド名と商品名だけを簡潔に書き、それ以外は省いてください。目安は20文字以内です。',
    '- 内容量（400g、100ml、1000ml、10個入、3P など）は含めないでください。',
    '- 型番・記号・アルファベットの識別子（LB81、L01 など）は含めないでください。',
    '- パッケージのキャッチコピーや成分の宣伝文句（「カルシウムと鉄分」「料理に最適」など）は含めないでください。',
    '- 例:「明治ブルガリアヨーグルト LB81 カルシウムと鉄分 400g」→「明治ブルガリアヨーグルト」',
    '- 例:「タカナシ 北海道純生クリーム35 100ml」→「タカナシ 純生クリーム」',
    '- 例:「おかめ納豆 極小粒 3P」→「おかめ納豆」',
    '- ただし種類を区別する語は残してください。例:「無調整豆乳」の「無調整」、「絹ごし豆腐」の「絹ごし」。',
    '',
    '複数商品について:',
    '- 写真に複数の食品が写っている場合は、1つも取りこぼさず items に1要素ずつ入れてください。',
    '- 並び順は写真の左から右。position には「左」「中央」「右奥」のように、どれを指すか分かる位置を書いてください。',
    '- ある商品の期限だけが読めない場合も、その商品を items から省かずに found を false で入れてください。',
    '- 別の商品の期限を取り違えて割り当てないこと。どの印字がどの商品のものか自信がなければ confidence を "low" にしてください。',
    '',
    '日付の読み取りについて:',
    '- 日本の食品では「25.09.06」「25 09 06」「2026.9」「26.09」「2027 02 21」などの表記が使われます。',
    '- 年月のみの表示（例「2026.9」）は、その月の末日を date に入れ、date_precision を "month" にしてください。',
    '- 「賞味期限」と「消費期限」を取り違えないこと。ラベル文字が読めない場合は label を "不明" にしてください。',
    '- 製造日・ロット番号・製造所固有記号・バーコード・価格・内容量を期限と誤認しないこと。',
    '  例:「26.09.14.K11」の K11、「26.09.17/+KA L01」の +KA L01、「2027 02 21 +KN/AAS132」の +KN/AAS132 は記号であり日付ではありません。',
    '- インクジェット印字がかすれている、曲面で歪んでいるなど確信が持てない場合は confidence を "low" にし、note に理由を書いてください。',
    '- どうしても読み取れない場合は found を false にし、date を空文字にしてください。推測で埋めないこと。'
  ].join('\n');
}

/** Claude Vision に画像を投げて期限情報を JSON で取得する */
function extractExpiry_(base64Image, mimeType) {
  return callClaude_([
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
    { type: 'text', text: buildPrompt_() }
  ], EXPIRY_SCHEMA, MODEL_VISION);
}

/** テキスト（音声入力を含む）を解析して期限情報を JSON で取得する */
function parseTextExpiry_(text) {
  return callClaude_([
    { type: 'text', text: buildTextPrompt_(text) }
  ], TEXT_EXPIRY_SCHEMA, MODEL_TEXT);
}

/** Messages API を叩き、structured output の JSON を返す共通処理 */
function callClaude_(content, schema, model) {
  var useModel = model || MODEL_VISION;
  var outputConfig = { format: { type: 'json_schema', schema: schema } };

  // effort は Haiku 4.5 では未対応（指定すると 400 になる）。対応モデルのみ付ける。
  // 抽出タスクなので低 effort で十分で、LINE の応答時間短縮にもなる。
  if (useModel.indexOf('haiku') < 0) {
    outputConfig.effort = 'low';
  }

  var payload = {
    model: useModel,
    max_tokens: 8000, // 複数商品を返すため余裕を持たせる
    output_config: outputConfig,
    messages: [{ role: 'user', content: content }]
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': prop_('ANTHROPIC_API_KEY', true),
      'anthropic-version': ANTHROPIC_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Claude API エラー (HTTP ' + res.getResponseCode() + '): '
      + res.getContentText().substring(0, 300));
  }

  var body = JSON.parse(res.getContentText());

  if (body.stop_reason === 'refusal') {
    throw new Error('リクエストが拒否されました');
  }

  // content 配列から text ブロックを拾って JSON としてパースする
  var text = '';
  for (var i = 0; i < body.content.length; i++) {
    if (body.content[i].type === 'text') text += body.content[i].text;
  }
  if (!text) throw new Error('Claude から応答テキストが返りませんでした');

  console.log('usage: ' + JSON.stringify(body.usage));
  // 返信は簡潔にしているため、判断の根拠（note / raw_text / confidence）はここに残す。
  // ⚠ が付いた理由を調べたいときは実行ログのこの行を見る。
  console.log('result: ' + text);
  return JSON.parse(text);
}

// ---------------------------------------------------------------- 返信文の組み立て

/** 今日から見た残日数 */
function daysLeft_(dateStr) {
  var d = new Date(dateStr + 'T00:00:00+09:00');
  var today = new Date(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd') + 'T00:00:00+09:00');
  return Math.round((d - today) / 86400000);
}

/** 期限が近い順に並べて、見出し付きの一覧テキストにする */
function formatItems_(items, header) {
  var sorted = items.slice().sort(function (a, b) {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  var multi = sorted.length > 1;
  var blocks = sorted.map(function (it, i) {
    return formatItem_(it, multi ? String(i + 1) + '. ' : '');
  });

  return header + '\n\n' + blocks.join('\n\n');
}

/**
 * 1件分を2行に整形する。
 *   1. ヨーグルト
 *     2026-09-17（11日）⚠
 * 末尾の ⚠ は、誤変換の訂正・言い直しの採用・年の補完などで
 * モデルの確度が high でなかったことを示す。理由は実行ログに残る。
 */
function formatItem_(it, prefix) {
  var name = it.item_name || '(食材名不明)';
  if (it.position) name += '［' + it.position + '］';

  if (!it.found || !it.date) {
    return prefix + name + '\n  期限を特定できず ⚠';
  }

  var days = daysLeft_(it.date);
  var remain = days < 0 ? days * -1 + '日超過' : days === 0 ? '今日まで' : days + '日';
  var approx = it.date_precision === 'month' ? '頃' : '';
  var warn = it.confidence === 'high' ? '' : ' ⚠';

  return prefix + name + '\n  ' + it.date + approx + '（' + remain + '）' + warn;
}

// ---------------------------------------------------------------- スプレッドシート操作

/** 在庫シートを返す。未設定なら手順を添えて落とす */
function sheet_() {
  var id = prop_('SPREADSHEET_ID', false);
  if (!id) {
    throw new Error('記録先が未設定です。GASエディタで setupSpreadsheet を1回実行してください。');
  }
  var sh = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('シート「' + SHEET_NAME + '」が見つかりません');
  return sh;
}

/**
 * 記録用スプレッドシートを新規作成し、ID をスクリプトプロパティに保存する。
 * エディタから1回だけ実行する。すでに設定済みなら何もしない。
 */
function setupSpreadsheet() {
  var existing = prop_('SPREADSHEET_ID', false);
  if (existing) {
    console.log('設定済みです: ' + SpreadsheetApp.openById(existing).getUrl());
    return;
  }

  var ss = SpreadsheetApp.create('食材在庫');
  var sh = ss.getSheets()[0].setName(SHEET_NAME);
  sh.getRange(1, 1, 1, COL_COUNT).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // 期限が日付型に自動変換されると扱いにくいので、文字列のまま保持する
  sh.getRange(2, COL.DATE, sh.getMaxRows() - 1, 1).setNumberFormat('@');

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  console.log('作成しました: ' + ss.getUrl());
}

/** Date でも文字列でも 'YYYY-MM-DD' に揃える */
function normalizeYmd_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v).trim();
}

/** 食材名の比較用に、空白と中黒を落として小文字化する */
function normalizeName_(s) {
  return String(s || '').replace(/[\s　・･\-ー]/g, '').toLowerCase();
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

/** 「商品名（2026-09-17・あと11日）」の形にする。どの商品を操作したか一目で確かめられるように */
function withDate_(name, date) {
  if (!date) return name;
  var d = daysLeft_(date);
  var remain = d < 0 ? (d * -1) + '日超過' : d === 0 ? '今日まで' : 'あと' + d + '日';
  return name + '（' + date + '・' + remain + '）';
}

/** シート1行を、表示用のアイテムオブジェクトに変換する */
function rowToItem_(row) {
  return {
    item_name: row[COL.NAME - 1],
    position: '',
    found: true,
    date: normalizeYmd_(row[COL.DATE - 1]),
    date_precision: row[COL.PRECISION - 1],
    label: row[COL.LABEL - 1],
    confidence: row[COL.CONFIDENCE - 1]
  };
}

// ---------------------------------------------------------------- 登録・消費・取消

/** 直前の操作を記録しておき、「取消」で戻せるようにする */
function setLastOp_(op) {
  PropertiesService.getScriptProperties().setProperty('LAST_OP', JSON.stringify(op));
}

function getLastOp_() {
  var s = prop_('LAST_OP', false);
  return s ? JSON.parse(s) : null;
}

/** 個数は 1〜20 に丸める。誤認識で大量登録されるのを防ぐ */
function normalizeQty_(q) {
  var n = parseInt(q, 10);
  if (!n || n < 1) return 1;
  return Math.min(n, 20);
}

/** 実際にシートへ追記し、追記した行番号を返す */
function appendRows_(sh, items, source) {
  if (!items.length) return [];

  var startRow = sh.getLastRow() + 1;
  var stamp = nowStamp_();

  var values = items.map(function (it) {
    var row = new Array(COL_COUNT).fill('');
    row[COL.REGISTERED - 1] = stamp;
    row[COL.NAME - 1] = it.item_name || '(名称不明)';
    row[COL.DATE - 1] = it.date;
    row[COL.PRECISION - 1] = it.date_precision || 'day';
    row[COL.LABEL - 1] = it.label || '不明';
    row[COL.CONFIDENCE - 1] = it.confidence || 'high';
    row[COL.SOURCE - 1] = source;
    row[COL.RAW - 1] = it.raw_text || '';
    row[COL.STATUS - 1] = STATUS.STOCK;
    row[COL.UPDATED - 1] = stamp;
    return row;
  });

  sh.getRange(startRow, 1, values.length, COL_COUNT).setValues(values);
  return values.map(function (_, i) { return startRow + i; });
}

/**
 * 読み取り結果をシートに追記する。
 * 同じ名前・同じ期限の在庫がすでにある場合は勝手に増やさず確認する。
 * ただし「2個買った」と個数が明示されていれば意図した重複なので確認しない。
 */
function registerItems_(items, source) {
  var ok = [];
  var ng = [];

  items.forEach(function (it) {
    if (!(it.found && it.date)) {
      ng.push(it.item_name || '(名称不明)');
      return;
    }
    var qty = normalizeQty_(it.quantity);
    for (var i = 0; i < qty; i++) {
      ok.push({ item: it, stated: qty > 1 });
    }
  });

  if (!ok.length) {
    return '期限を特定できなかったため登録しませんでした。\n'
      + '日付を添えて送り直してください。';
  }

  var sh = sheet_();
  // 追記する前の在庫と突き合わせる。
  // 同じ写真に同じ商品が2つ写っている場合は実物が2つあるということなので、
  // ここで作った集合には入らず、確認せずどちらも登録される。
  var stockKeys = stockKeySet_(sh);

  var toAdd = [];
  var toConfirm = [];
  ok.forEach(function (e) {
    var key = normalizeName_(e.item.item_name) + '|' + e.item.date;
    if (!e.stated && stockKeys[key]) toConfirm.push(e.item);
    else toAdd.push(e.item);
  });

  return finishRegister_(sh, {
    kind: 'register',
    source: source,
    changed: appendRows_(sh, toAdd, source),
    registered: toAdd,
    confirm: toConfirm,
    ng: ng,
    skipped: 0
  });
}

/** 確認待ちがあれば保留して問い返し、なければ結果を返す */
function finishRegister_(sh, session) {
  if (session.confirm.length) {
    savePending_(session);
    var head = buildRegisterReport_(session, false);
    var q = formatDuplicateQuestion_(session.confirm);
    return head ? head + '\n\n' + q : q;
  }

  clearPending_();
  if (session.changed.length) {
    setLastOp_({ type: 'register', rows: session.changed });
  }
  return buildRegisterReport_(session, true) || '登録するものがありませんでした。';
}

function buildRegisterReport_(session, isFinal) {
  var parts = [];
  if (session.registered.length) {
    parts.push(formatItems_(session.registered, session.registered.length + '件を登録しました'));
  }
  if (session.ng.length) {
    parts.push('※ 期限が不明で登録できなかったもの: ' + session.ng.join('、'));
  }
  if (isFinal && session.skipped) {
    parts.push('※ 重複として ' + session.skipped + '件は登録しませんでした。');
  }
  return parts.join('\n\n');
}

function formatDuplicateQuestion_(confirm) {
  var lines = ['同じものが既に在庫にあります。', ''];
  confirm.forEach(function (it) {
    lines.push('・' + (it.item_name || '(名称不明)') + '（' + it.date + '）');
  });
  lines.push('');
  lines.push('1. 登録する（2つ目を買った）');
  lines.push('2. 登録しない（二重登録だった）');
  lines.push('');
  lines.push('番号でも「登録する」「登録しない」でも答えられます。');
  return lines.join('\n');
}

/** 重複確認への回答を処理する */
function resolveRegister_(n) {
  var session = getPending_();
  if (!session || session.kind !== 'register' || !session.confirm.length) {
    clearPending_();
    return '確認の対象がありません。';
  }

  if (n !== 1 && n !== 2) {
    savePending_(session);
    return '1 か 2 で答えてください。\n\n' + formatDuplicateQuestion_(session.confirm);
  }

  var sh = sheet_();
  if (n === 1) {
    session.changed = session.changed.concat(appendRows_(sh, session.confirm, session.source));
    session.registered = session.registered.concat(session.confirm);
  } else {
    session.skipped = session.confirm.length;
  }
  session.confirm = [];

  return finishRegister_(sh, session);
}

var STOCK_MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      description: 'ユーザーが言った食材名ごとに1要素',
      items: {
        type: 'object',
        properties: {
          said: { type: 'string', description: 'ユーザーが言った食材名（与えられた文字列をそのまま返す）' },
          row: { type: 'number', description: '該当する在庫の行番号。該当なしは 0' },
          reason: { type: 'string', description: 'そう判断した理由を日本語で簡潔に' }
        },
        required: ['said', 'row', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['matches'],
  additionalProperties: false
};

/**
 * 文字列一致で見つからなかった食材を、在庫リストと意味で突き合わせる。
 * 商品名は写真から読み取った正式名称になるため、
 * 「コーヒー」→「ネスカフェ ゴールドブレンド」のような言い換えを解決する。
 */
function matchStockByClaude_(names, stock) {
  var prompt = [
    'ユーザーが「使った」「捨てた」と言った食材が、在庫リストのどれを指すか特定してください。',
    '',
    '在庫リスト（行番号: 商品名（期限））',
    stock.map(function (s) { return s.row + ': ' + s.name + '（' + s.date + '）'; }).join('\n'),
    '',
    'ユーザーが言った食材:',
    names.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n'),
    '',
    '判断の指針:',
    '- 商品名は写真から読み取った正式名称です。ユーザーは略称・一般名・カテゴリ名で呼びます。',
    '  例:「ヨーグルト」→「ダノンビオ」、「コーヒー」→「ネスカフェ ゴールドブレンド」',
    '- 表記ゆれは同一とみなしてください。例: 卵/たまご/タマゴ、豆腐/とうふ',
    '- 同じ食材が複数該当する場合は、期限が最も近い行を選んでください。',
    '- 該当する在庫がなければ row を 0 にしてください。似ているだけの別の食材で代用しないこと。',
    '  例: ユーザーが「牛乳」と言い、在庫に「豆乳」しかない場合は 0 です。',
    '- 同じ行を複数の食材に割り当てないでください。'
  ].join('\n');

  var result = callClaude_([{ type: 'text', text: prompt }], STOCK_MATCH_SCHEMA, MODEL_TEXT);
  return (result && result.matches) || [];
}

/** 在庫にある「名前|期限」の集合。重複判定に使う */
function stockKeySet_(sh) {
  var keys = {};
  var last = sh.getLastRow();
  if (last < 2) return keys;

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  data.forEach(function (row) {
    if (row[COL.STATUS - 1] !== STATUS.STOCK) return;
    keys[normalizeName_(row[COL.NAME - 1]) + '|' + normalizeYmd_(row[COL.DATE - 1])] = true;
  });
  return keys;
}

/**
 * 「牛乳使った」等に対応して在庫を消す。
 * 同名が複数あるときは期限が近いものを1件だけ対象にする。
 */
function consumeItems_(items, disposed) {
  if (!items.length) return '対象の食材を読み取れませんでした。';

  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return '在庫がまだありません。';

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var newStatus = disposed ? STATUS.DISCARDED : STATUS.USED;
  var stamp = nowStamp_();

  // 在庫だけを行番号つきで取り出す
  var stock = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] !== STATUS.STOCK) continue;
    stock.push({
      row: i + 2,
      name: data[i][COL.NAME - 1],
      date: normalizeYmd_(data[i][COL.DATE - 1])
    });
  }
  if (!stock.length) return '在庫がありません。';

  // この一連のやり取りの状態。候補が複数あるものは queue に積んで質問する
  var session = {
    action: disposed ? 'discard' : 'consume',
    changed: [], done: [], missed: [], queue: []
  };
  var unresolved = [];

  // 第1段階: 名前の文字列一致で探す（API を使わないので速い）
  items.forEach(function (it) {
    var key = normalizeName_(it.item_name);
    if (!key) {
      session.missed.push(it.item_name || '(名称不明)');
      return;
    }

    var candidates = stock.filter(function (s) {
      if (session.changed.indexOf(s.row) >= 0) return false; // 同じ発話で二重に消さない
      var name = normalizeName_(s.name);
      return name.indexOf(key) >= 0 || key.indexOf(name) >= 0;
    });

    if (!candidates.length) {
      unresolved.push(it.item_name); // 第2段階に回す
      return;
    }

    candidates.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    if (candidates.length === 1) {
      markRow_(sh, candidates[0], session);
    } else {
      // 勝手に選ばず、どれかを尋ねる
      session.queue.push({ said: it.item_name, choices: candidates });
    }
  });

  // 第2段階: 文字列で当たらなかったものだけ、意味でClaudeに照合させる
  // （「コーヒー」→「ネスカフェ ゴールドブレンド」や「たまご」→「卵」を拾うため）
  if (unresolved.length) {
    var remaining = stock.filter(function (s) { return session.changed.indexOf(s.row) < 0; });
    var matches = [];
    if (remaining.length) {
      try {
        matches = matchStockByClaude_(unresolved, remaining);
      } catch (err) {
        console.error('在庫の意味照合に失敗: ' + err.stack);
      }
    }

    unresolved.forEach(function (said) {
      var hit = null;
      for (var j = 0; j < matches.length; j++) {
        if (matches[j].said !== said || !matches[j].row) continue;
        for (var k = 0; k < remaining.length; k++) {
          if (remaining[k].row === matches[j].row && session.changed.indexOf(matches[j].row) < 0) {
            hit = remaining[k];
          }
        }
        break;
      }
      if (hit) markRow_(sh, hit, session); else session.missed.push(said);
    });
  }

  return finishSession_(sh, session);
}

/** 対象行を消費済み（または破棄）にして、返信用の1行を積む */
function markRow_(sh, choice, session) {
  sh.getRange(choice.row, COL.STATUS)
    .setValue(session.action === 'discard' ? STATUS.DISCARDED : STATUS.USED);
  sh.getRange(choice.row, COL.UPDATED).setValue(nowStamp_());
  session.changed.push(choice.row);
  session.done.push(withDate_(choice.name, choice.date));
}

/**
 * 候補が複数ある質問を先頭から処理する。
 * すでに消した行を候補から除いた結果、残り1件になれば自動で確定し、
 * 0件になればその食材は見つからなかった扱いにする。
 * まだ選んでもらう必要があれば質問文を返す。
 */
function advanceQueue_(sh, session) {
  while (session.queue.length) {
    var q = session.queue[0];
    q.choices = q.choices.filter(function (c) { return session.changed.indexOf(c.row) < 0; });

    if (!q.choices.length) {
      session.missed.push(q.said);
      session.queue.shift();
    } else if (q.choices.length === 1) {
      markRow_(sh, q.choices[0], session);
      session.queue.shift();
    } else {
      return formatQuestion_(q, session.action);
    }
  }
  return null;
}

function formatQuestion_(q, action) {
  var lines = [
    '「' + q.said + '」に該当する在庫が ' + q.choices.length + '件あります。',
    (action === 'discard' ? '破棄' : '消費') + 'したものを番号で答えてください。',
    ''
  ];
  q.choices.forEach(function (c, i) {
    lines.push((i + 1) + '. ' + withDate_(c.name, c.date));
  });
  lines.push('');
  lines.push('（やめる場合は「やめる」）');
  return lines.join('\n');
}

/** 済んだ分の報告文を作る。何もなければ空文字 */
function buildSessionReport_(session, isFinal) {
  var lines = [];
  if (session.done.length) {
    lines.push((session.action === 'discard' ? '破棄' : '消費')
      + 'として記録しました（' + session.done.length + '件）');
    lines.push('');
    session.done.forEach(function (d, i) { lines.push((i + 1) + '. ' + d); });
  }
  if (session.missed.length) {
    if (lines.length) lines.push('');
    lines.push('※ 在庫に見つかりませんでした: ' + session.missed.join('、'));
    if (!session.done.length && isFinal) {
      lines.push('　「在庫」と送ると登録済みの一覧を確認できます。');
    }
  }
  return lines.join('\n');
}

/** 質問が残っていれば保留して問い返し、すべて片付いたら結果を返す */
function finishSession_(sh, session) {
  var question = advanceQueue_(sh, session);

  if (question) {
    savePending_(session);
    var head = buildSessionReport_(session, false);
    return head ? head + '\n\n' + question : question;
  }

  clearPending_();
  if (session.changed.length) {
    setLastOp_({ type: 'consume', rows: session.changed });
  }
  // 空文字を返すと LINE の返信 API がエラーになり、何も返らなくなるので必ず何か返す
  return buildSessionReport_(session, true) || '対象の食材を読み取れませんでした。';
}

// ---------------------------------------------------------------- 選択待ちの状態

var PENDING_TTL_MS = 10 * 60 * 1000; // 古い質問に後から番号だけ返すと事故になるので時間で失効させる

function savePending_(session) {
  session.ts = Date.now();
  PropertiesService.getScriptProperties().setProperty('PENDING', JSON.stringify(session));
}

function getPending_() {
  var s = prop_('PENDING', false);
  if (!s) return null;
  var session = JSON.parse(s);
  if (Date.now() - (session.ts || 0) > PENDING_TTL_MS) {
    clearPending_();
    return null;
  }
  return session;
}

function clearPending_() {
  PropertiesService.getScriptProperties().deleteProperty('PENDING');
}

/** 全角英数を半角にし、記号と空白を落とす */
function toPlain_(text) {
  return String(text)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s　。、．，.,！!？?「」]/g, '')
    .toLowerCase();
}

/** 「2」「２」「2番」「2つ目」などから番号を取り出す。番号でなければ null */
function parseChoice_(text) {
  var m = toPlain_(text).match(/^(\d{1,2})(番|番目|つ目|個目|です|でお願いします|にします)?$/);
  return m ? parseInt(m[1], 10) : null;
}

var YES_PATTERN = /^(1|登録する|登録|する|はい|うん|ok|おっけー|オッケー|了解|買った|2つ目|2つ目を買った|追加|追加する|そう|yes|y)$/;
var NO_PATTERN = /^(2|登録しない|しない|いらない|不要|いいえ|いや|違う|ちがう|間違い|間違え|重複|だぶり|no|n)$/;

/** 重複確認への回答。「登録しない」のような言葉でも答えられるようにする */
function parseRegisterAnswer_(text) {
  var t = toPlain_(text);
  if (YES_PATTERN.test(t)) return 1;
  if (NO_PATTERN.test(t)) return 2;
  return parseChoice_(text);
}

function isCancelWord_(text) {
  return /^(やめる|やめて|キャンセル|中止|とりやめ)$/.test(toPlain_(text));
}

// ---------------------------------------------------------------- API を使わない近道

var USED_VERB = /^(.{1,14}?)(?:を|は)?(使った|使いました|つかった|食べた|たべた|食べました|飲んだ|のんだ|飲みました|消費した|開けた)$/;
var DISCARD_VERB = /^(.{1,14}?)(?:を|は)?(捨てた|すてた|捨てました|処分した|廃棄した|だめにした)$/;

/**
 * 「牛乳使った」のような単純な一文は、Claude を呼ばずにその場で解釈する。
 * 最頻の操作なので、ここを素通しできるとトークンが目に見えて減る。
 * 少しでも解釈に幅がある書き方（複数指定・日付つきなど）は null を返し、
 * これまでどおり Claude に任せる。
 */
function parseConsumeFast_(text) {
  var t = String(text).replace(/[。、．，.,!！]/g, '').trim();

  var m = t.match(USED_VERB);
  var disposed = false;
  if (!m) {
    m = t.match(DISCARD_VERB);
    disposed = true;
  }
  if (!m) return null;

  var name = m[1].trim();
  if (!name) return null;

  // 複数まとめて言われた場合や、日付・数量が混ざる場合は自前で解釈しない
  if (/[とやも、,・\s]/.test(name)) return null;
  if (/[0-9０-９]/.test(name)) return null;
  if (/(昨日|今日|さっき|先ほど|全部|ぜんぶ)/.test(name)) return null;

  return { disposed: disposed, item_name: name };
}

/** 番号で選ばれた候補を確定する */
function resolvePending_(n) {
  var session = getPending_();
  if (!session || !session.queue.length) {
    clearPending_();
    return '選択の対象がありません。';
  }

  var q = session.queue[0];
  if (n < 1 || n > q.choices.length) {
    savePending_(session);
    return '1〜' + q.choices.length + ' の番号で答えてください。\n\n' + formatQuestion_(q, session.action);
  }

  var sh = sheet_();
  markRow_(sh, q.choices[n - 1], session);
  session.queue.shift();
  return finishSession_(sh, session);
}

/** 選択・確認を中止する。すでに記録した分はそのまま残す */
function cancelPending_() {
  var session = getPending_();
  clearPending_();
  if (!session) return '中止する操作がありません。';

  var kind = session.kind === 'register' ? 'register' : 'consume';
  if (session.changed.length) {
    setLastOp_({ type: kind, rows: session.changed });
    return '中止しました。\nすでに記録した ' + session.changed.length + '件はそのままです。';
  }
  return '中止しました。記録は変更していません。';
}

/** 直前の登録・消費を元に戻す。行は消さず状態列だけ書き換える */
function undoLast_() {
  var op = getLastOp_();
  if (!op || !op.rows || !op.rows.length) {
    return '取り消せる操作がありません。';
  }

  var sh = sheet_();
  var stamp = nowStamp_();
  var names = [];

  op.rows.forEach(function (row) {
    if (row > sh.getLastRow()) return;
    names.push(withDate_(
      sh.getRange(row, COL.NAME).getValue(),
      normalizeYmd_(sh.getRange(row, COL.DATE).getValue())
    ));
    sh.getRange(row, COL.STATUS)
      .setValue(op.type === 'register' ? STATUS.CANCELED : STATUS.STOCK);
    sh.getRange(row, COL.UPDATED).setValue(stamp);
  });

  PropertiesService.getScriptProperties().deleteProperty('LAST_OP');

  if (!names.length) return '取り消せる操作がありません。';

  var head = (op.type === 'register' ? '直前の登録を取り消しました' : '直前の消費を取り消して在庫に戻しました')
    + '（' + names.length + '件）';
  var body = names.length > 1
    ? names.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n')
    : names[0];

  return head + '\n\n' + body;
}

/** 在庫の一覧を返す */
function listStock_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return '在庫はまだありません。';

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var items = data
    .filter(function (row) { return row[COL.STATUS - 1] === STATUS.STOCK; })
    .map(rowToItem_);

  if (!items.length) return '在庫はありません。';
  return formatItems_(items, '在庫 ' + items.length + '件');
}

// ---------------------------------------------------------------- 週次通知

/**
 * 毎週土曜の朝に実行する。
 * 1品につき「残り30日を切った最初の土曜」と「残り7日を切った最初の土曜」の2回だけ通知し、
 * 期限切れのものは処分の報告を受けるまで毎週先頭に再掲する。
 * 該当がなければ push を送らない（LINE の無料通数を消費しないため）。
 */
function notifyWeekly() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) { console.log('在庫なし。通知をスキップ'); return; }

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  var expired = [], week = [], month = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (row[COL.STATUS - 1] !== STATUS.STOCK) continue;

    var date = normalizeYmd_(row[COL.DATE - 1]);
    if (!date) continue;

    var days = daysLeft_(date);
    var item = rowToItem_(row);
    var sheetRow = i + 2;

    if (days < 0) {
      expired.push(item);
    } else if (days <= NOTIFY_1W_DAYS) {
      if (row[COL.NOTIFIED_1W - 1]) continue;
      week.push(item);
      // 残り7日を切ると1か月の予告はもう出番がないので、あわせて済みにする
      sh.getRange(sheetRow, COL.NOTIFIED_1M).setValue(today);
      sh.getRange(sheetRow, COL.NOTIFIED_1W).setValue(today);
    } else if (days <= NOTIFY_1M_DAYS) {
      if (row[COL.NOTIFIED_1M - 1]) continue;
      month.push(item);
      sh.getRange(sheetRow, COL.NOTIFIED_1M).setValue(today);
    }
  }

  if (!expired.length && !week.length && !month.length) {
    console.log('通知対象なし。push をスキップ');
    return;
  }

  var parts = [];
  if (expired.length) parts.push(formatItems_(expired, '■ 期限切れ（' + expired.length + '件）'));
  if (week.length) parts.push(formatItems_(week, '■ 残り1週間（' + week.length + '件）'));
  if (month.length) parts.push(formatItems_(month, '■ 残り1か月（' + month.length + '件）'));

  pushText_(parts.join('\n\n'));
  console.log('通知しました: 期限切れ' + expired.length + ' / 1週間' + week.length + ' / 1か月' + month.length);
}

/** 自分宛に push 送信する（返信と違い LINE の無料通数を消費する） */
function pushText_(text) {
  var to = prop_('ALLOWED_USER_ID', false);
  if (!to) {
    throw new Error('通知先が未設定です。スクリプトプロパティ ALLOWED_USER_ID に自分の userId を設定してください。');
  }

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    payload: JSON.stringify({
      to: to,
      messages: [{ type: 'text', text: text.substring(0, 4900) }]
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('LINE push 失敗 (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
  }
}

/**
 * 毎週土曜 8時台に notifyWeekly を実行するトリガーを設定する。
 * エディタから1回だけ実行する。同じ関数の古いトリガーがあれば張り替える。
 */
function setupWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'notifyWeekly') {
      console.log('既存トリガーを張り替えます');
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('notifyWeekly')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SATURDAY)
    .atHour(8)
    .create();

  console.log('毎週土曜 8時台に notifyWeekly を実行するトリガーを設定しました');
}

// ---------------------------------------------------------------- 動作確認用

/** エディタから実行して、プロパティ設定と Claude API 疎通を確認する */
function testConfig() {
  ['LINE_CHANNEL_ACCESS_TOKEN', 'ANTHROPIC_API_KEY'].forEach(function (k) {
    console.log(k + ': ' + (prop_(k, false) ? 'OK' : '*** 未設定 ***'));
  });

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/models/' + ANTHROPIC_MODEL, {
    method: 'get',
    headers: {
      'x-api-key': prop_('ANTHROPIC_API_KEY', true),
      'anthropic-version': ANTHROPIC_VERSION
    },
    muteHttpExceptions: true
  });
  console.log('Claude API 疎通: HTTP ' + res.getResponseCode() + ' / ' + res.getContentText().substring(0, 200));
}
