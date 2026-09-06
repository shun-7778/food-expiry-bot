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
 * タスクごとにモデルを分ける。
 *   写真の読み取り … 印字を読むぶん難度は高いが、Sonnet で足りる想定
 *   テキストの解析・在庫の突き合わせ … 易しいので最安の Haiku
 *
 * 単価（入力/出力 per MTok）と画像1枚あたりの目安:
 *   'claude-opus-5'    $5 / $25   約2.7円/枚  精度最優先
 *   'claude-sonnet-5'  $2 / $10   約1.1円/枚  バランス型
 *   'claude-haiku-4-5' $1 / $5    約0.6円/枚  最安（effort 非対応。自動で除外される）
 *
 * 読み取りを外すようなら MODEL_VISION を 'claude-opus-5' に戻す。
 */
var MODEL_VISION = 'claude-sonnet-5';
var MODEL_TEXT = 'claude-haiku-4-5';
var ANTHROPIC_VERSION = '2023-06-01';
var MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Claude の画像サイズ上限に対する安全マージン

// ---------------------------------------------------------------- スプレッドシート定義

var SHEET_NAME = '在庫';

// 列番号（1始まり）。順番を変えるときはヘッダーと合わせて直すこと。
var COL = {
  REG_DATE: 1,    // 登録日 (YYYY-MM-DD)
  REG_TIME: 2,    // 登録時刻 (HH:mm)
  NAME: 3,        // 食材名
  DATE: 4,        // 期限 (YYYY-MM-DD)
  PRECISION: 5,   // day / month
  LABEL: 6,       // 賞味期限 / 消費期限
  CONFIDENCE: 7,  // high / medium / low
  SOURCE: 8,      // 写真 / テキスト
  RAW: 9,         // 原文（写真の印字、または発話の該当部分）
  STATUS: 10,     // 在庫 / 消費済 / 破棄 / 取消
  UPDATED: 11,    // 状態を最後に変えた日時
  NOTIFIED_1M: 12, // 残り1か月の通知を送った日
  NOTIFIED_1W: 13  // 残り1週間の通知を送った日
};
var COL_COUNT = 13;

var HEADERS = ['登録日', '登録時刻', '食材名', '期限', '精度', 'ラベル', '確度',
  '入力元', '原文', '状態', '更新日時', '通知1M', '通知1W'];

var STATUS = { STOCK: '在庫', USED: '消費済', DISCARDED: '破棄', CANCELED: '取消' };

// ---------------------------------------------------------------- 買い物リスト定義

var SHOP_SHEET_NAME = '買い物リスト';

var SHOP_COL = {
  ADDED: 1,    // 追加日 (YYYY-MM-DD)
  NAME: 2,     // 品名
  STATUS: 3,   // 未購入 / 購入済 / 取消
  UPDATED: 4   // 状態を最後に変えた日時
};
var SHOP_COL_COUNT = 4;

var SHOP_HEADERS = ['追加日', '品名', '状態', '更新日時'];

var SHOP_STATUS = { TODO: '未購入', DONE: '購入済', CANCELED: '取消' };

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
  '■ 下のメニュー',
  '押すと入力欄に「期限登録 」などが入ります。',
  '続けて中身を打って送ってください。',
  '　期限登録 牛乳 9月10日',
  '　使用済 牛乳',
  '　破棄済 豆腐',
  '　買い物リスト追加 牛乳と卵',
  '　買い物リスト削除 牛乳',
  '種別が確定するので、取り違えが起きません。',
  'これまでどおり接頭辞なしでも送れます。',
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
  '「片栗粉2つ捨てた」「牛乳全部使った」もまとめて可',
  '迷う候補があるときだけ番号で聞きます（例: 1,3）',
  '',
  '■ 通知',
  '毎週土曜の朝、期限が近いものをお知らせします。',
  '1品につき残り1か月と残り1週間の2回だけです。',
  '',
  '■ 買い物リスト',
  '「買い物リストに牛乳と卵を追加」',
  '「牛乳買った」… リストから外す',
  '「買い物リスト」… 一覧',
  '「買い物リストを全部削除」… 空にする',
  '',
  '■ コマンド',
  '在庫 … 在庫の一覧',
  '取消 … 直前の登録・消費を取り消す',
  'id … あなたの userId を表示'
].join('\n');

var PHOTO_EMPTY_MESSAGE = '食品を検出できませんでした。\n商品と期限の印字が写るように撮り直してみてください。';
var TEXT_EMPTY_MESSAGE = '食材と期限を読み取れませんでした。\n「豆乳は2027年2月21日」のように、食材名と日付を続けて送ってください。';

// ---------------------------------------------------------------- 接頭辞コマンド

/**
 * 「期限登録 牛乳 9月10日」のように、先頭で操作を宣言してもらう形。
 * リッチメニューを押すと接頭辞が入力欄に差し込まれる（postback の fillInText）。
 * 種別が確定するので intent の推定が要らなくなり、「牛乳買った（買い物リスト）」と
 * 「牛乳使った（在庫の消費）」の取り違えが起きない。
 *
 * 押しただけで送信されるわけではなく、続きを打って自分で送信する。
 * 接頭辞を消して送ることもできるので、従来どおりの自由入力も残る。
 *
 * ボタンの見出しと差し込む語は同じにしてある。トークに残る自分の発言と
 * 押したボタンが一致するので、後から履歴を見て何をしたのか分かる。
 *
 * 接頭辞として認める語。リッチメニューが差し込む語のほかに、手打ちしそうな
 * 言い方も拾う。RICHMENU_CELLS の語は必ずここに含めること（testConfig で検査）
 */
var COMMAND_WORDS = {
  '期限登録': 'register',
  '登録': 'register',
  '使用済': 'consume',
  '使った': 'consume',
  '消費': 'consume',
  '破棄済': 'discard',
  '捨てた': 'discard',
  '破棄': 'discard',
  '買い物リスト追加': 'shop_add',
  '買い物追加': 'shop_add',
  '買い物リスト削除': 'shop_bought',
  '買った': 'shop_bought',
  '購入': 'shop_bought'
};

// ボタンだけ押して中身を書かずに送られたときの案内
var COMMAND_HINTS = {
  register: '「期限登録 牛乳 9月10日」のように、食材名と期限を続けて送ってください。',
  consume: '「使用済 牛乳」のように、使った食材名を続けて送ってください。',
  discard: '「破棄済 豆腐」のように、捨てた食材名を続けて送ってください。',
  shop_add: '「買い物リスト追加 牛乳と卵」のように、買うものを続けて送ってください。',
  shop_bought: '「買い物リスト削除 牛乳」のように、買ってきたものを続けて送ってください。'
};

/**
 * 接頭辞つきの入力を {action, rest} に分解する。接頭辞がなければ null。
 * 区切りの空白を必須にしているので、「買ったよ牛乳」のような地の文は拾わない。
 */
function parseCommand_(text) {
  var m = String(text).trim().match(/^([^\s　:：]+)(?:[\s　:：]+([\s\S]+))?$/);
  if (!m) return null;

  var action = COMMAND_WORDS[m[1]];
  if (!action) return null;

  // ボタンを押しただけで送ると接頭辞だけが届く。案内を返せるよう rest は空で通す
  return { action: action, rest: (m[2] || '').trim() };
}

/** 買い物リストの品名を Claude に特定させ、追加または削除する */
function runShopCommand_(action, text) {
  var items = parseItemNames_(text);
  if (!items.length) return '品名を読み取れませんでした。';

  var names = items.map(function (it) { return it.name; });
  return action === 'shop_add' ? shopAdd_(names) : shopBought_(names);
}

/** 在庫から消す食材を Claude に特定させ、消費または破棄として記録する */
function runConsumeCommand_(disposed, text) {
  var items = parseItemNames_(text);
  if (!items.length) return '対象の食材を読み取れませんでした。';

  return consumeItems_(items.map(function (it) {
    return { item_name: it.name, quantity: it.quantity };
  }), disposed);
}

/**
 * 接頭辞で種別が確定した入力を処理する。
 * 種別は押されたボタンで決まっているので、品名の特定だけを Claude に任せる。
 */
function runCommand_(cmd) {
  if (!cmd.rest) return COMMAND_HINTS[cmd.action];

  if (cmd.action === 'shop_add' || cmd.action === 'shop_bought') {
    return runShopCommand_(cmd.action, cmd.rest);
  }
  if (cmd.action === 'consume' || cmd.action === 'discard') {
    return runConsumeCommand_(cmd.action === 'discard', cmd.rest);
  }

  var result = parseTextExpiry_(cmd.rest);
  var items = (result && result.items) || [];
  if (!items.length) return TEXT_EMPTY_MESSAGE;

  return registerItems_(items, 'テキスト');
}

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
    var answer = pending.kind === 'register' ? parseRegisterAnswer_(text) : parseChoiceList_(text);
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

  // 接頭辞で種別が宣言されていれば、推定せずそのとおりに処理する
  var cmd = parseCommand_(text);
  if (cmd) {
    try {
      replyText_(event.replyToken, prefixReply_(note, runCommand_(cmd)));
    } catch (err) {
      console.error('接頭辞コマンドの処理に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
    }
    return;
  }

  // 買い物リストの操作は言い回しが定型なので、種別の判定は API を使わずに済む。
  // 品名の特定だけ Claude に任せる（runShopCommand_）
  if (SHOP_LIST_CMD.test(text)) {
    replyText_(event.replyToken, note + shopList_());
    return;
  }
  if (SHOP_CLEAR_CMD.test(text)) {
    replyText_(event.replyToken, note + shopClear_());
    return;
  }
  var shopAdd = parseShopAddFast_(text);
  if (shopAdd) {
    try {
      replyText_(event.replyToken, prefixReply_(note, runShopCommand_('shop_add', shopAdd)));
    } catch (err) {
      console.error('買い物リストへの追加に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
    }
    return;
  }
  var bought = text.replace(/[。．!！]/g, '').trim().match(BOUGHT_VERB);
  if (bought) {
    try {
      replyText_(event.replyToken, prefixReply_(note, runShopCommand_('shop_bought', bought[1])));
    } catch (err) {
      console.error('買い物リストからの削除に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
    }
    return;
  }

  // 「牛乳使った」のような言い方も、種別は正規表現で決まる。品名だけ Claude に任せる
  var fast = parseConsumeFast_(text);
  if (fast) {
    try {
      replyText_(event.replyToken,
        prefixReply_(note, runConsumeCommand_(fast.disposed, fast.text)));
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

    var names = items.map(function (it) { return it.item_name; })
      .filter(function (n) { return n; });

    if (intent === 'shop_list') {
      replyText_(event.replyToken, note + shopList_());
      return;
    }
    if (intent === 'shop_clear') {
      replyText_(event.replyToken, note + shopClear_());
      return;
    }
    if (intent === 'shop_add' && names.length) {
      replyText_(event.replyToken, note + shopAdd_(names));
      return;
    }
    if (intent === 'shop_bought' && names.length) {
      replyText_(event.replyToken, note + shopBought_(names));
      return;
    }
    if (intent === 'consume' || intent === 'discard') {
      replyText_(event.replyToken,
        prefixReply_(note, consumeItems_(items, intent === 'discard')));
      return;
    }
    if (intent === 'register' && items.length) {
      replyText_(event.replyToken, prefixReply_(note, registerItems_(items, 'テキスト')));
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

// Quick Reply のボタン数の上限（LINE 仕様）
var QUICK_REPLY_MAX = 13;

/**
 * 返信の中身。文字列だけの返信と、ボタン付きの返信を同じ形で扱う。
 * ボタンを押すと label と同じテキストが送られてくるので、
 * 受け側（parseChoiceList_ など）は手入力と区別せずそのまま処理できる。
 */
function asReply_(reply) {
  return typeof reply === 'string' ? { text: reply, labels: null } : reply;
}

/** 返信の先頭に断り書きを足す。ボタンはそのまま保つ */
function prefixReply_(note, reply) {
  var r = asReply_(reply);
  return note ? { text: note + r.text, labels: r.labels } : r;
}

/**
 * 候補の番号など、押すとその文字列がそのまま送信されるボタンを組み立てる。
 * 常設のコマンドはリッチメニュー側に移したので、ここは質問への回答専用。
 */
function buildQuickReply_(labels) {
  return {
    items: labels.slice(0, QUICK_REPLY_MAX).map(function (label) {
      var s = String(label);
      return {
        type: 'action',
        action: { type: 'message', label: s.substring(0, 20), text: s }
      };
    })
  };
}

/**
 * 返信トークンで返す。reply は文字列または {text, labels}。
 * ボタンは質問を返すときだけ付く（labels を指定した場合のみ）。
 */
function replyText_(replyToken, reply) {
  if (!replyToken) return;

  var r = asReply_(reply);
  var message = { type: 'text', text: r.text.substring(0, 4900) };
  if (r.labels && r.labels.length) {
    message.quickReply = buildQuickReply_(r.labels);
  }

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [message]
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
    label: { type: 'string', description: '「賞味期限」か「消費期限」のいずれか。消費期限と印字されている場合のみ「消費期限」、それ以外は「賞味期限」' },
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
    label: { type: 'string', description: '「賞味期限」か「消費期限」のいずれか。消費期限と明示された場合のみ「消費期限」、それ以外は「賞味期限」' },
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
      description: '"register"（期限の登録）| "consume"（食べた・使った）| "discard"（捨てた）'
        + '| "shop_add"（買い物リストに追加）| "shop_bought"（買ったのでリストから外す）'
        + '| "shop_clear"（買い物リストを空に）| "shop_list"（買い物リストを見る）| "unknown"'
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
    '- "shop_add"    … 買い物リストに入れたい。例「買い物リストに牛乳と卵を追加」「パン買っておきたい」',
    '- "shop_bought" … 買ってきたのでリストから外す。例「牛乳買った」「卵は買えた」',
    '- "shop_clear"  … 買い物リストを空にする。例「買い物リスト全部消して」',
    '- "shop_list"   … 買い物リストを見たい。例「買い物リスト見せて」「何買うんだっけ」',
    '- "unknown"     … 上記のいずれでもない、または食材が読み取れない',
    '',
    '在庫と買い物リストは別物です。次の違いに注意してください。',
    '- 「牛乳使った」「牛乳食べた」… 手持ちを消費した → consume',
    '- 「牛乳買った」          … 買ってきた → shop_bought（在庫への登録ではありません）',
    '- 「牛乳は9月10日」        … 期限を伝えている → register',
    'shop_add / shop_bought では品名だけを items に入れ、date は空文字にしてください。',
    '',
    'consume / discard の場合は、対象の食材名だけを items に入れてください。',
    'その場合 date は空文字、found は false のままで構いません（日付が述べられていればその日付を入れてください）。',
    '個数が述べられていれば quantity に入れてください。例:「片栗粉2つ捨てた」→ quantity=2。',
    '「全部」「すべて」と言われた場合は quantity=99 にしてください（該当する在庫すべての意味）。',
    'なお 99 を使うのは consume / discard のときだけです。register では実際に買った個数だけを入れてください。',
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
    '- label は「賞味期限」か「消費期限」のどちらかです。取り違えると安全性の判断が変わるため慎重に扱ってください。',
    '  「消費期限」と明示された場合のみ label を "消費期限" にします。「消費」「消費期限が」「消費の方」なども同じ扱いです。',
    '  それ以外はすべて "賞味期限" にしてください。何も言われていない場合も "賞味期限" です。',
    '  例:「牛乳は消費期限が9月10日」→ label="消費期限"',
    '  例:「豆腐、消費期限明日まで」→ label="消費期限"',
    '  例:「味噌は9月30日」→ label="賞味期限"',
    '  1つの発話に複数の食材がある場合、ラベルは食材ごとに判断してください。',
    '  例:「牛乳は消費期限9月10日、味噌は9月30日」→ 牛乳="消費期限"、味噌="賞味期限"',
    '  「消費期限」という語が1つの食材に付いていても、他の食材まで消費期限にしないこと。',
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
    '- label は「消費期限」と印字されている場合のみ "消費期限"、それ以外はすべて "賞味期限" にしてください。',
    '  ラベル文字が読み取れない場合も "賞味期限" にします。',
    '  「消費期限」は過ぎたら食べない方がよいという意味なので、印字を慎重に確認してください。',
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

var NAMES_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: '述べられた品名ごとに1要素。登場順に並べる',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '品名。個数・内容量・助詞は含めない' },
          quantity: { type: 'number', description: '個数。述べられていなければ 1。「全部」は 99' },
          note: { type: 'string', description: '訂正や判断に迷った点を日本語で1文。なければ空文字' }
        },
        required: ['name', 'quantity', 'note'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
};

function buildNamesPrompt_(text) {
  return [
    '述べられた食品名を列挙してください。日付や期限は関係ありません。',
    '',
    '入力はスマートフォンの音声入力で作られている前提です。',
    '区切りの記号がないまま品名が続けて並べられることがあります。',
    '',
    '- 例:「牛乳コチュジャンプロテイン」→ 牛乳／コチュジャン／プロテイン の3件',
    '- 例:「牛乳と卵」→ 牛乳／卵 の2件。この「と」は助詞です',
    '- 例:「とうふとうもろこし」→ とうふ／とうもろこし の2件。',
    '  「と」は助詞のこともあれば品名の一部のこともあります。文字面で切らず、',
    '  食品として意味の通る単位で切ってください。',
    '- 1品の長い商品名を無理に分割しないこと。',
    '  例:「ブルガリアヨーグルト」→ 1件。「エクストラバージンオリーブオイル」→ 1件',
    '- 明らかな音声誤認識は妥当な食品名に訂正し、note に理由を書いてください。',
    '  例:「投入」→「豆乳」',
    '- 品名として読み取れるものがなければ items を空の配列にしてください。',
    '',
    '個数について:',
    '- 個数や内容量は name に含めないでください。例:「牛乳2本」→ name「牛乳」',
    '- 個数が述べられていれば quantity に入れてください。',
    '  「2個」「2本」「2つ」「2パック」などが対象です。',
    '  内容量（1リットル、400g）は個数ではないので quantity は 1 のままにしてください。',
    '- 述べられていなければ quantity は 1 にしてください。',
    '- 「全部」「すべて」と言われた場合は quantity を 99 にしてください。',
    '',
    '--- 入力 ---',
    text
  ].join('\n');
}

/**
 * 文から食品名（と個数）を取り出す。
 * 記号で切ると「とうふ」の「と」まで落ちてしまい、
 * 「牛乳コチュジャンプロテイン」のような区切りなしの並びも切れないため、
 * 品名の特定は Claude に任せている。
 */
function parseItemNames_(text) {
  var result = callClaude_([
    { type: 'text', text: buildNamesPrompt_(text) }
  ], NAMES_SCHEMA, MODEL_TEXT);

  return ((result && result.items) || [])
    .map(function (it) {
      return { name: String(it.name || '').trim(), quantity: it.quantity };
    })
    .filter(function (it) { return it.name; });
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

  return prefix + name + '\n  ' + labelPrefix_(it.label) + it.date + approx
    + '（' + remain + '）' + warn;
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
  // 「12:55」が時刻値に変換されると読み戻しが面倒になるので文字列で保つ
  sh.getRange(2, COL.REG_TIME, sh.getMaxRows() - 1, 1).setNumberFormat('@');

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

function todayStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function timeStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
}

/**
 * 表示に使うラベル。消費期限は「過ぎたら食べない」という安全側の意味を持つので、
 * 賞味期限と取り違えないよう必ず出す。読み取れていない場合は何も付けない。
 */
function labelPrefix_(label) {
  return (label === '賞味期限' || label === '消費期限') ? label + ' ' : '';
}

/** 「商品名（消費期限 2026-09-17・あと11日）」の形にする */
function withDate_(name, date, label) {
  if (!date) return name;
  var d = daysLeft_(date);
  var remain = d < 0 ? (d * -1) + '日超過' : d === 0 ? '今日まで' : 'あと' + d + '日';
  return name + '（' + labelPrefix_(label) + date + '・' + remain + '）';
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

/** 種別は「消費期限」と明示されたときだけ消費期限。それ以外はすべて賞味期限に寄せる */
function normalizeLabel_(label) {
  return label === '消費期限' ? '消費期限' : '賞味期限';
}

/**
 * 個数を 1〜max に丸める。誤認識による暴発を防ぐためのもの。
 * 登録は実在する買い物の数なので 20 まで、
 * 消費・破棄は「全部」を 99 で表すので 99 まで許す。
 */
function clampQty_(q, max) {
  var n = parseInt(q, 10);
  if (!n || n < 1) return 1;
  return Math.min(n, max);
}

/** 実際にシートへ追記し、追記した行番号を返す */
function appendRows_(sh, items, source) {
  if (!items.length) return [];

  var startRow = sh.getLastRow() + 1;
  var stamp = nowStamp_();

  var values = items.map(function (it) {
    var row = new Array(COL_COUNT).fill('');
    row[COL.REG_DATE - 1] = todayStamp_();
    row[COL.REG_TIME - 1] = timeStamp_();
    row[COL.NAME - 1] = it.item_name || '(名称不明)';
    row[COL.DATE - 1] = it.date;
    row[COL.PRECISION - 1] = it.date_precision || 'day';
    row[COL.LABEL - 1] = normalizeLabel_(it.label);
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
    // 返信とシートで表示が食い違わないよう、ここで種別を確定させる
    it.label = normalizeLabel_(it.label);
    var qty = clampQty_(it.quantity, 20);
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
    return head ? { text: head + '\n\n' + q.text, labels: q.labels } : q;
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
  return {
    text: lines.join('\n'),
    labels: ['登録する', '登録しない', 'やめる']
  };
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
    var q = formatDuplicateQuestion_(session.confirm);
    return { text: '1 か 2 で答えてください。\n\n' + q.text, labels: q.labels };
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
      date: normalizeYmd_(data[i][COL.DATE - 1]),
      label: data[i][COL.LABEL - 1]
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
    // 何件処理するかは advanceQueue_ が判断する（自動で片付くならそこで片付く）
    session.queue.push({ said: it.item_name, choices: candidates, need: clampQty_(it.quantity, 99) });
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
  session.done.push(withDate_(choice.name, choice.date, choice.label));
}

/** 名前も期限も同じなら、どちらを消しても結果は変わらない */
function allSameItem_(list) {
  for (var i = 1; i < list.length; i++) {
    if (normalizeName_(list[i].name) !== normalizeName_(list[0].name)) return false;
    if (list[i].date !== list[0].date) return false;
  }
  return true;
}

/**
 * 候補が複数ある質問を先頭から処理する。
 * 尋ねる必要がないものはここで片付ける:
 *   - すでに消した行を除いて0件 … 見つからなかった扱い
 *   - 候補が必要数以下 … 全部そのまま処理する（「2つ捨てた」で在庫が2件など）
 *   - 名前も期限も同じものが並ぶだけ … どれを選んでも同じなので先頭から必要数だけ処理する
 * それ以外は質問文を返す。
 */
function advanceQueue_(sh, session) {
  while (session.queue.length) {
    var q = session.queue[0];
    var need = q.need || 1;
    q.choices = q.choices.filter(function (c) { return session.changed.indexOf(c.row) < 0; });

    if (!q.choices.length) {
      session.missed.push(q.said);
      session.queue.shift();
      continue;
    }

    if (q.choices.length <= need || allSameItem_(q.choices)) {
      q.choices.slice(0, need).forEach(function (c) { markRow_(sh, c, session); });
      session.queue.shift();
      continue;
    }

    return formatQuestion_(q, session.action);
  }
  return null;
}

function formatQuestion_(q, action) {
  var need = q.need || 1;
  var verb = action === 'discard' ? '破棄' : '消費';

  var lines = ['「' + q.said + '」に該当する在庫が ' + q.choices.length + '件あります。'];
  lines.push(need > 1
    ? verb + 'した ' + need + '件を、番号をカンマ区切りで答えてください。（例: 1,3）'
    : verb + 'したものを番号で答えてください。');
  lines.push('');

  q.choices.forEach(function (c, i) {
    lines.push((i + 1) + '. ' + withDate_(c.name, c.date, c.label));
  });

  lines.push('');
  lines.push('（すべてなら「全部」、やめる場合は「やめる」）');

  // 1件だけ選ぶ場合はボタンで済ませられる。
  // 複数選ぶ場合はタップでは表せない（1つ押した時点で確定してしまう）ので、
  // 番号のボタンは出さず、カンマ区切りの手入力に委ねる。
  var labels = [];
  if (need === 1) {
    var max = Math.min(q.choices.length, QUICK_REPLY_MAX - 2);
    for (var i = 0; i < max; i++) labels.push(String(i + 1));
  }
  labels.push('全部', 'やめる');

  return { text: lines.join('\n'), labels: labels };
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
    return head ? { text: head + '\n\n' + question.text, labels: question.labels } : question;
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

/**
 * 消費・破棄の候補選択への回答。
 * 「1」「1,3」「1 3」「全部」に対応する。番号として読めなければ null。
 */
function parseChoiceList_(text) {
  var t = String(text)
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[、，,。．・とや]/g, ' ')
    .trim();

  if (/^(全部|すべて|全て|ぜんぶ|ぜんぶです)$/.test(t.replace(/\s/g, ''))) return 'all';

  var parts = t.split(/\s+/).filter(function (s) { return s; });
  if (!parts.length) return null;

  var nums = [];
  for (var i = 0; i < parts.length; i++) {
    var m = parts[i].match(/^(\d{1,2})(番|番目|つ目|個目|です)?$/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    if (nums.indexOf(n) < 0) nums.push(n);
  }
  return nums;
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

var SHOP_LIST_CMD = /^(買い物リスト|買物リスト|買うもの|買い物)$/;
var SHOP_CLEAR_CMD = /^買い?物リスト(を)?(全部|すべて|全て|ぜんぶ)?(削除|消して|消す|クリア|リセット|空に)(して|する)?$/;
var BOUGHT_VERB = /^(.{1,14}?)(?:を|は)?(買った|買いました|購入した|買ってきた|買えた)$/;
var SHOP_ADD_A = /^買い?物リスト(?:に|へ)(.+?)(?:を)?(?:追加|入れて|足して|加えて|メモ)(?:して|しといて|しておいて|とく)?$/;
var SHOP_ADD_B = /^(.+?)(?:を)?買い?物リスト(?:に|へ)(?:追加|入れて|足して|加えて|メモ)(?:して|しといて|しておいて|とく)?$/;

/**
 * 「買い物リストに牛乳を追加」形式かどうかを判定し、品名の部分を返す。
 * 種別の判定はここで済むので、Claude は品名の特定にだけ使う。
 */
function parseShopAddFast_(text) {
  var t = String(text).replace(/[。．!！]/g, '').trim();
  var m = t.match(SHOP_ADD_A) || t.match(SHOP_ADD_B);
  return m ? m[1].trim() : null;
}

/**
 * 「牛乳使った」「豆腐捨てた」形式かどうかを判定し、
 * 消費か破棄かと、食材名の部分を返す。
 * 品名の切り分けは Claude に任せるので、ここでは種別だけ決める。
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
  return name ? { disposed: disposed, text: name } : null;
}

/**
 * 選ばれた候補を確定する。
 * selection は番号の配列、または全件を表す 'all'。
 */
function resolvePending_(selection) {
  var session = getPending_();
  if (!session || !session.queue.length) {
    clearPending_();
    return '選択の対象がありません。';
  }

  var q = session.queue[0];
  var picks;

  if (selection === 'all') {
    picks = q.choices.slice();
  } else {
    var bad = selection.filter(function (n) { return n < 1 || n > q.choices.length; });
    if (bad.length) {
      savePending_(session);
      var question = formatQuestion_(q, session.action);
      return {
        text: '1〜' + q.choices.length + ' の番号で答えてください。\n\n' + question.text,
        labels: question.labels
      };
    }
    picks = selection.map(function (n) { return q.choices[n - 1]; });
  }

  var sh = sheet_();
  picks.forEach(function (c) { markRow_(sh, c, session); });
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
  if (op.sheet === 'shopping') return undoShopping_(op);

  var sh = sheet_();
  var stamp = nowStamp_();
  var names = [];

  op.rows.forEach(function (row) {
    if (row > sh.getLastRow()) return;
    names.push(withDate_(
      sh.getRange(row, COL.NAME).getValue(),
      normalizeYmd_(sh.getRange(row, COL.DATE).getValue()),
      sh.getRange(row, COL.LABEL).getValue()
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

/** 買い物リスト側の取り消し。追加は取消印、購入済は未購入に戻す */
function undoShopping_(op) {
  var sh = shopSheet_();
  var stamp = nowStamp_();
  var back = op.type === 'shop_add' ? SHOP_STATUS.CANCELED : SHOP_STATUS.TODO;
  var names = [];

  op.rows.forEach(function (row) {
    if (row > sh.getLastRow()) return;
    names.push(sh.getRange(row, SHOP_COL.NAME).getValue());
    sh.getRange(row, SHOP_COL.STATUS).setValue(back);
    sh.getRange(row, SHOP_COL.UPDATED).setValue(stamp);
  });

  PropertiesService.getScriptProperties().deleteProperty('LAST_OP');
  if (!names.length) return '取り消せる操作がありません。';

  var head = op.type === 'shop_add' ? '直前の追加を取り消しました'
    : op.type === 'shop_clear' ? '買い物リストを元に戻しました'
    : '買い物リストに戻しました';

  return head + '（' + names.length + '件）\n' + names.join('、');
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

// ---------------------------------------------------------------- 買い物リスト

/**
 * 買い物リストのシートを返す。無ければ作り、ヘッダーが無ければ入れる。
 * （手動で空のシートだけ作ってある状態でもそのまま使えるようにしている）
 */
function shopSheet_() {
  var id = prop_('SPREADSHEET_ID', false);
  if (!id) {
    throw new Error('記録先が未設定です。GASエディタで setupSpreadsheet を1回実行してください。');
  }

  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(SHOP_SHEET_NAME) || ss.insertSheet(SHOP_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, SHOP_COL_COUNT).setValues([SHOP_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 未購入の行を {row, name} で返す */
function shopTodoRows_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];

  var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][SHOP_COL.STATUS - 1] !== SHOP_STATUS.TODO) continue;
    out.push({ row: i + 2, name: data[i][SHOP_COL.NAME - 1] });
  }
  return out;
}

/** 買い物リストに品名を追加する。すでに未購入で載っているものは足さない */
function shopAdd_(names) {
  var clean = names
    .map(function (n) { return String(n || '').trim(); })
    .filter(function (n) { return n; });
  if (!clean.length) return '追加するものを読み取れませんでした。';

  var sh = shopSheet_();
  var todo = shopTodoRows_(sh);
  var known = {};
  todo.forEach(function (t) { known[normalizeName_(t.name)] = t.name; });

  var added = [];
  var dup = [];
  clean.forEach(function (n) {
    var key = normalizeName_(n);
    if (known[key]) { dup.push(known[key]); return; }
    known[key] = n;   // 同じ発話の中での重複も防ぐ
    added.push(n);
  });

  var lines = [];
  if (added.length) {
    var startRow = sh.getLastRow() + 1;
    var stamp = nowStamp_();
    var values = added.map(function (n) {
      var row = new Array(SHOP_COL_COUNT).fill('');
      row[SHOP_COL.ADDED - 1] = todayStamp_();
      row[SHOP_COL.NAME - 1] = n;
      row[SHOP_COL.STATUS - 1] = SHOP_STATUS.TODO;
      row[SHOP_COL.UPDATED - 1] = stamp;
      return row;
    });
    sh.getRange(startRow, 1, values.length, SHOP_COL_COUNT).setValues(values);

    setLastOp_({
      type: 'shop_add',
      sheet: 'shopping',
      rows: values.map(function (_, i) { return startRow + i; })
    });

    lines.push('買い物リストに追加しました（' + added.length + '件）');
    lines.push('');
    added.forEach(function (n, i) { lines.push((i + 1) + '. ' + n); });
  }

  if (dup.length) {
    if (lines.length) lines.push('');
    lines.push('※ すでにリストにあります: ' + dup.join('、'));
  }
  return lines.join('\n');
}

/** 買ったものをリストから外す（購入済にする） */
function shopBought_(names) {
  var sh = shopSheet_();
  var todo = shopTodoRows_(sh);
  if (!todo.length) return '買い物リストは空です。';

  var stamp = nowStamp_();
  var done = [];
  var missed = [];
  var changed = [];

  names.forEach(function (n) {
    var key = normalizeName_(n);
    if (!key) { missed.push(n || '(名称不明)'); return; }

    var hit = null;
    for (var i = 0; i < todo.length; i++) {
      if (changed.indexOf(todo[i].row) >= 0) continue;
      var name = normalizeName_(todo[i].name);
      if (name.indexOf(key) >= 0 || key.indexOf(name) >= 0) { hit = todo[i]; break; }
    }

    if (!hit) { missed.push(n); return; }

    sh.getRange(hit.row, SHOP_COL.STATUS).setValue(SHOP_STATUS.DONE);
    sh.getRange(hit.row, SHOP_COL.UPDATED).setValue(stamp);
    changed.push(hit.row);
    done.push(hit.name);
  });

  if (changed.length) {
    setLastOp_({ type: 'shop_bought', sheet: 'shopping', rows: changed });
  }

  var lines = [];
  if (done.length) {
    lines.push('買い物リストから外しました（' + done.length + '件）');
    lines.push('');
    done.forEach(function (n, i) { lines.push((i + 1) + '. ' + n); });
  }
  if (missed.length) {
    if (lines.length) lines.push('');
    lines.push('※ リストに見つかりませんでした: ' + missed.join('、'));
  }
  return lines.length ? lines.join('\n') : '対象を読み取れませんでした。';
}

/** 未購入をすべて購入済にする。行は消さないので「取消」で戻せる */
function shopClear_() {
  var sh = shopSheet_();
  var todo = shopTodoRows_(sh);
  if (!todo.length) return '買い物リストはすでに空です。';

  var stamp = nowStamp_();
  todo.forEach(function (t) {
    sh.getRange(t.row, SHOP_COL.STATUS).setValue(SHOP_STATUS.DONE);
    sh.getRange(t.row, SHOP_COL.UPDATED).setValue(stamp);
  });

  setLastOp_({
    type: 'shop_clear',
    sheet: 'shopping',
    rows: todo.map(function (t) { return t.row; })
  });

  return '買い物リストを空にしました（' + todo.length + '件）\n'
    + todo.map(function (t) { return t.name; }).join('、')
    + '\n\n戻す場合は「取消」と送ってください。';
}

/** 未購入の一覧 */
function shopList_() {
  var todo = shopTodoRows_(shopSheet_());
  if (!todo.length) return '買い物リストは空です。';

  return '買い物リスト ' + todo.length + '件\n\n'
    + todo.map(function (t, i) { return (i + 1) + '. ' + t.name; }).join('\n');
}

// ---------------------------------------------------------------- リッチメニュー

/**
 * トーク下部に常設するメニュー。Quick Reply と違い常に見えていて、
 * PC版のLINEでも表示される（Quick Reply は iOS/Android のみ）。
 *
 * 押すと fillInText が入力欄に入るだけで送信はされない。続きを打って自分で送る。
 * ただし postback イベント自体は届くので、doPost 側では無視している
 * （handleEvent_ が message 以外を早期 return する）。
 */
var RICHMENU_SIZE = { width: 2500, height: 1686 };

// richmenu.png の格子と一致させること。列幅の合計は width と同じでなければならない
var RICHMENU_COLS = [{ x: 0, w: 833 }, { x: 833, w: 834 }, { x: 1667, w: 833 }];
var RICHMENU_ROWS = [{ y: 0, h: 843 }, { y: 843, h: 843 }];

// 画像と同じ並び（左上から右へ、上段→下段）
var RICHMENU_CELLS = [
  { fill: '期限登録 ' },
  { fill: '使用済 ' },
  { fill: '破棄済 ' },
  { fill: '買い物リスト追加 ' },
  { fill: '買い物リスト削除 ' },
  { send: '買い物リスト' }   // 一覧は入力するものがないのでそのまま送信する
];

function buildRichMenu_() {
  return {
    size: RICHMENU_SIZE,
    selected: true,          // 友だち追加時から開いた状態にする
    name: '食材在庫メニュー',
    chatBarText: 'メニュー',
    areas: RICHMENU_CELLS.map(function (cell, i) {
      var c = RICHMENU_COLS[i % RICHMENU_COLS.length];
      var r = RICHMENU_ROWS[Math.floor(i / RICHMENU_COLS.length)];
      return {
        bounds: { x: c.x, y: r.y, width: c.w, height: r.h },
        action: cell.send
          ? { type: 'message', text: cell.send }
          : {
            type: 'postback',
            data: 'fill',   // 使わないが postback には必須
            inputOption: 'openKeyboard',
            fillInText: cell.fill
          }
      };
    })
  };
}

function lineApi_(method, url, options) {
  var res = UrlFetchApp.fetch(url, Object.assign({
    method: method,
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    muteHttpExceptions: true
  }, options || {}));

  if (res.getResponseCode() !== 200) {
    throw new Error('LINE API 失敗 (HTTP ' + res.getResponseCode() + ') ' + url + '\n'
      + res.getContentText().substring(0, 300));
  }
  return res;
}

/**
 * リッチメニューを作り直して既定に設定する。エディタから実行する。
 * 画像や配置を変えたら、そのつど実行し直すこと。
 * 古いものは消してから作るので、何度実行しても増えない。
 */
function setupRichMenu() {
  var old = JSON.parse(lineApi_('get', 'https://api.line.me/v2/bot/richmenu/list').getContentText());
  (old.richmenus || []).forEach(function (m) {
    lineApi_('delete', 'https://api.line.me/v2/bot/richmenu/' + m.richMenuId);
    console.log('古いリッチメニューを削除: ' + m.richMenuId);
  });

  var created = JSON.parse(lineApi_('post', 'https://api.line.me/v2/bot/richmenu', {
    contentType: 'application/json',
    payload: JSON.stringify(buildRichMenu_())
  }).getContentText());
  var id = created.richMenuId;
  console.log('作成: ' + id);

  var png = Utilities.newBlob(
    Utilities.base64Decode(RICHMENU_IMAGE_BASE64), 'image/png', 'richmenu.png');
  lineApi_('post', 'https://api-data.line.me/v2/bot/richmenu/' + id + '/content', {
    contentType: 'image/png',
    payload: png.getBytes()
  });
  console.log('画像をアップロード: ' + Math.round(png.getBytes().length / 1024) + 'KB');

  lineApi_('post', 'https://api.line.me/v2/bot/user/all/richmenu/' + id);
  console.log('既定のリッチメニューに設定しました。トークを開き直すと出ます。');
}

/** リッチメニューを全部消す。表示を止めたいときにエディタから実行する */
function deleteRichMenus() {
  var list = JSON.parse(lineApi_('get', 'https://api.line.me/v2/bot/richmenu/list').getContentText());
  var menus = list.richmenus || [];
  if (!menus.length) { console.log('リッチメニューはありません'); return; }

  menus.forEach(function (m) {
    lineApi_('delete', 'https://api.line.me/v2/bot/richmenu/' + m.richMenuId);
    console.log('削除: ' + m.richMenuId);
  });
}

// ---------------------------------------------------------------- 動作確認用

/**
 * 品名の切り分けを確かめる。エディタから実行する。
 * 区切りのない並びや、品名に「と」を含むものが正しく切れるか見るためのもの。
 * シートには何も書かないので、何度実行しても副作用はない。
 */
function testItemNames() {
  [
    '牛乳コチュジャンプロテイン',   // 区切りなしの並び
    '牛乳と卵',                   // 「と」は助詞
    'とうふとうもろこし',           // 「と」が品名の一部
    '納豆とうふねぎ',
    'ブルガリアヨーグルト',         // 単品。分割しないこと
    'エクストラバージンオリーブオイル',
    '牛乳2本と卵1パック',          // 個数
    '牛乳1リットル',               // 内容量は個数ではない
    '片栗粉2つ',
    '牛乳全部'                    // quantity=99
  ].forEach(function (t) {
    try {
      console.log(t + '  ->  ' + parseItemNames_(t).map(function (it) {
        return it.name + '×' + it.quantity;
      }).join(' / '));
    } catch (err) {
      console.log(t + '  ->  *** ' + err.message + ' ***');
    }
  });
}

/** エディタから実行して、プロパティ設定と Claude API 疎通を確認する */
function testConfig() {
  ['LINE_CHANNEL_ACCESS_TOKEN', 'ANTHROPIC_API_KEY'].forEach(function (k) {
    console.log(k + ': ' + (prop_(k, false) ? 'OK' : '*** 未設定 ***'));
  });

  [MODEL_VISION, MODEL_TEXT].forEach(function (model) {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/models/' + model, {
      method: 'get',
      headers: {
        'x-api-key': prop_('ANTHROPIC_API_KEY', true),
        'anthropic-version': ANTHROPIC_VERSION
      },
      muteHttpExceptions: true
    });
    console.log(model + ': HTTP ' + res.getResponseCode()
      + (res.getResponseCode() === 200 ? ' OK' : ' / ' + res.getContentText().substring(0, 150)));
  });

  // リッチメニューが差し込む語を COMMAND_WORDS に足し忘れると、
  // 押しても普通の文として扱われてしまう。目に見えにくいのでここで検査する
  RICHMENU_CELLS.forEach(function (cell, i) {
    if (cell.send) {
      console.log('メニュー' + (i + 1) + '「' + cell.send + '」: そのまま送信');
      return;
    }
    var cmd = parseCommand_(cell.fill + 'テスト');
    console.log('メニュー' + (i + 1) + '「' + cell.fill.trim() + '」: '
      + (cmd ? cmd.action + ' OK' : '*** COMMAND_WORDS に未登録 ***'));
  });

  // 画像の格子とタップ領域がずれていないか
  var areas = buildRichMenu_().areas;
  var right = Math.max.apply(null, areas.map(function (a) { return a.bounds.x + a.bounds.width; }));
  var bottom = Math.max.apply(null, areas.map(function (a) { return a.bounds.y + a.bounds.height; }));
  console.log('リッチメニュー: ' + areas.length + '領域 / 右端' + right + ' 下端' + bottom
    + (right === RICHMENU_SIZE.width && bottom === RICHMENU_SIZE.height
      ? ' OK' : ' *** 画像サイズと不一致 ***'));
}
