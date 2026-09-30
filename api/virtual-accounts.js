const crypto = require("node:crypto");

const participants = {
  "민지": 15000,
  "서연": 9000,
  "유진": 8000
};
const keyPrefix = "moa:demo-group-0928-03";
const recordTtlSeconds = 60 * 60 * 24 * 30;
const isParticipant = (id) => Object.hasOwn(participants, id);
const groupStateKey = `${keyPrefix}:group-state`;

function encryptRefundAccount(account) {
  if (!account || typeof account !== "object") return null;
  const { bankCode, accountNumber, holderName } = account;
  if (![bankCode, accountNumber, holderName].every((value) => typeof value === "string" && value.length > 0)) return null;

  const key = crypto.createHash("sha256").update(validateEnvironment().TOSS_SECRET_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ bankCode, accountNumber, holderName }), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
}

function decryptRefundAccount(encrypted) {
  if (!encrypted) return null;
  const key = crypto.createHash("sha256").update(validateEnvironment().TOSS_SECRET_KEY).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, "base64")),
    decipher.final()
  ]).toString("utf8"));
}

async function readGroupState() {
  return (await readRecord(groupStateKey)) || { status: "ACTIVE" };
}

async function writeGroupState(state) {
  await writeRecord(groupStateKey, state);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function validateEnvironment() {
  const { TOSS_CLIENT_KEY, TOSS_SECRET_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, PUBLIC_APP_URL } = process.env;
  if (!TOSS_CLIENT_KEY || !TOSS_CLIENT_KEY.startsWith("test_ck_")) {
    throw new Error("Vercel에 test_ck_로 시작하는 Toss 테스트 클라이언트 키를 설정해 주세요.");
  }
  if (!TOSS_SECRET_KEY || !TOSS_SECRET_KEY.startsWith("test_sk_")) {
    throw new Error("Vercel에 test_sk_로 시작하는 Toss 테스트 시크릿 키를 설정해 주세요.");
  }
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Vercel에 Upstash Redis URL과 token 환경 변수를 설정해 주세요.");
  }
  if (!PUBLIC_APP_URL || !/^https:\/\/[a-z0-9.-]+$/i.test(PUBLIC_APP_URL)) {
    throw new Error("Vercel에 https:// 주소 형식의 PUBLIC_APP_URL을 설정해 주세요.");
  }
  return { TOSS_CLIENT_KEY, TOSS_SECRET_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, PUBLIC_APP_URL };
}

async function redisCommand(command) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = validateEnvironment();
  const response = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error("입금 상태 저장소 요청에 실패했습니다.");
  return result.result;
}

async function readRecord(key) {
  const value = await redisCommand(["GET", key]);
  return value ? JSON.parse(value) : null;
}

async function writeRecord(key, record) {
  await redisCommand(["SET", key, JSON.stringify(record), "EX", String(recordTtlSeconds)]);
}

async function tossRequest(path, options = {}) {
  const { TOSS_SECRET_KEY } = validateEnvironment();
  const response = await fetch(`https://api.tosspayments.com${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${Buffer.from(`${TOSS_SECRET_KEY}:`).toString("base64")}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.message || "토스페이먼츠 요청에 실패했습니다.");
    error.statusCode = response.status;
    throw error;
  }
  return body;
}

function publicAccount(record, includeAccountNumber = false) {
  const account = record.virtualAccount || {};
  return {
    participantId: record.participantId,
    participantName: record.participantName,
    amount: record.amount,
    status: record.status,
    orderId: record.orderId,
    createdAt: record.createdAt,
    refundStatus: record.refundStatus || null,
    bankCode: account.bank || null,
    accountNumber: includeAccountNumber ? account.accountNumber || null : null,
    dueDate: account.dueDate || null
  };
}

function validGroupId(groupId) {
  return groupId === "demo-group-0928-03";
}

async function handleGet(req, res) {
  const { groupId, participantId } = req.query;
  if (!validGroupId(groupId)) return json(res, 400, { error: "유효하지 않은 공동배달 ID입니다." });
  if (participantId && !isParticipant(participantId)) return json(res, 400, { error: "유효하지 않은 참여자입니다." });

  const accounts = await Promise.all(Object.keys(participants).map(async (id) => {
    const record = await readRecord(`${keyPrefix}:${id}`);
    return record
      ? publicAccount(record, id === participantId)
      : { participantId: id, participantName: id, amount: participants[id], status: "NOT_ISSUED" };
  }));
  const groupState = await readGroupState();
  return json(res, 200, {
    accounts,
    groupState: { status: groupState.status, canceledAt: groupState.canceledAt || null }
  });
}

async function handlePost(req, res) {
  const { groupId, participantId, action, orderId } = req.body || {};
  if (!validGroupId(groupId) || !isParticipant(participantId)) {
    return json(res, 400, { error: "공동배달 또는 참여자 정보를 확인해 주세요." });
  }
  if ((await readGroupState()).status !== "ACTIVE") {
    return json(res, 409, { error: "미입금으로 이미 취소된 공동배달입니다." });
  }

  const recordKey = `${keyPrefix}:${participantId}`;
  if (action === "abandon") {
    if (typeof orderId !== "string") return json(res, 400, { error: "중단할 주문번호가 없습니다." });
    const pending = await readRecord(`${keyPrefix}:order:${orderId}`);
    if (!pending || pending.participantId !== participantId || pending.status !== "REQUESTING") {
      return json(res, 409, { error: "중단할 결제 요청을 찾을 수 없습니다." });
    }
    pending.status = "FAILED";
    await writeRecord(recordKey, pending);
    await writeRecord(`${keyPrefix}:order:${orderId}`, pending);
    return json(res, 200, { abandoned: true });
  }

  const existing = await readRecord(recordKey);
  if (existing?.status === "WAITING_FOR_DEPOSIT" || existing?.status === "PAID" || existing?.status === "CANCEL_FAILED") {
    return json(res, 409, { error: "이미 발급된 가상계좌가 있어요. 기존 계좌를 확인해 주세요." });
  }
  if (existing?.status === "REQUESTING" && Date.now() - Date.parse(existing.createdAt) < 10 * 60_000) {
    return json(res, 409, { error: "가상계좌 발급이 진행 중이에요. 잠시 후 다시 시도해 주세요." });
  }

  const lockKey = `${recordKey}:lock`;
  const lockToken = crypto.randomUUID();
  const locked = await redisCommand(["SET", lockKey, lockToken, "NX", "EX", "30"]);
  if (locked !== "OK") return json(res, 409, { error: "가상계좌 발급을 처리 중이에요. 잠시 후 다시 시도해 주세요." });

  try {
    if ((await readGroupState()).status !== "ACTIVE") {
      return json(res, 409, { error: "미입금으로 이미 취소된 공동배달입니다." });
    }
    const current = await readRecord(recordKey);
    if (current?.status === "WAITING_FOR_DEPOSIT" || current?.status === "PAID" || current?.status === "CANCEL_FAILED") {
      return json(res, 409, { error: "이미 발급된 가상계좌가 있어요. 기존 계좌를 확인해 주세요." });
    }
    if (current?.status === "REQUESTING") {
      current.status = "EXPIRED";
      await writeRecord(`${keyPrefix}:order:${current.orderId}`, current);
    }
    const { TOSS_CLIENT_KEY, PUBLIC_APP_URL } = validateEnvironment();
    const orderId = `MOA-${crypto.randomUUID()}`;
    const amount = participants[participantId];
    const pending = {
      groupId,
      participantId,
      participantName: participantId,
      amount,
      orderId,
      status: "REQUESTING",
      createdAt: new Date().toISOString()
    };
    await writeRecord(recordKey, pending);
    await writeRecord(`${keyPrefix}:order:${orderId}`, pending);
    return json(res, 201, {
      clientKey: TOSS_CLIENT_KEY,
      orderId,
      amount,
      orderName: `모아먹자 공동배달 분담금 - ${participantId}`,
      customerName: participantId,
      successUrl: `${PUBLIC_APP_URL}/payment-success.html`,
      failUrl: `${PUBLIC_APP_URL}/payment-fail.html?orderId=${encodeURIComponent(orderId)}&participantId=${encodeURIComponent(participantId)}`
    });
  } finally {
    const currentToken = await redisCommand(["GET", lockKey]);
    if (currentToken === lockToken) await redisCommand(["DEL", lockKey]);
  }
}

module.exports = async function virtualAccounts(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "지원하지 않는 요청 방식입니다." });
  }
  try {
    validateEnvironment();
    if (req.method === "GET") return await handleGet(req, res);
    return await handlePost(req, res);
  } catch (error) {
    const statusCode = error.statusCode || (error.message.startsWith("Vercel에") ? 503 : 502);
    if (statusCode >= 500) console.error("Virtual account API error:", error.message);
    return json(res, statusCode, { error: error.message });
  }
};

module.exports.redisCommand = redisCommand;
module.exports.readRecord = readRecord;
module.exports.writeRecord = writeRecord;
module.exports.tossRequest = tossRequest;
module.exports.publicAccount = publicAccount;
module.exports.keyPrefix = keyPrefix;
module.exports.participants = participants;
module.exports.readGroupState = readGroupState;
module.exports.writeGroupState = writeGroupState;
module.exports.encryptRefundAccount = encryptRefundAccount;
module.exports.decryptRefundAccount = decryptRefundAccount;
