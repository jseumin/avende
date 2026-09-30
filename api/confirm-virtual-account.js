const { readRecord, writeRecord, tossRequest, publicAccount, keyPrefix } = require("./virtual-accounts");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = async function confirmVirtualAccount(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "POST 요청만 지원합니다." });
  }
  try {
    const { paymentKey, orderId, amount } = req.body || {};
    if (typeof paymentKey !== "string" || typeof orderId !== "string" || !Number.isSafeInteger(Number(amount))) {
      return json(res, 400, { error: "결제 승인 정보가 올바르지 않습니다." });
    }
    const record = await readRecord(`${keyPrefix}:order:${orderId}`);
    if (!record || record.status === "CANCELED" || record.status === "EXPIRED") {
      return json(res, 404, { error: "승인할 공동배달 주문을 찾을 수 없습니다." });
    }
    if (Number(amount) !== record.amount) {
      return json(res, 400, { error: "요청 금액이 참여자 분담액과 일치하지 않습니다." });
    }
    if (record.status === "PAID" || record.status === "WAITING_FOR_DEPOSIT") {
      return json(res, 200, { account: publicAccount(record, true) });
    }
    if (record.status !== "REQUESTING") {
      return json(res, 409, { error: "현재 결제 요청은 더 이상 승인할 수 없습니다." });
    }

    const payment = await tossRequest("/v1/payments/confirm", {
      method: "POST",
      body: JSON.stringify({ paymentKey, orderId, amount: record.amount })
    });
    if (payment.orderId !== orderId || payment.totalAmount !== record.amount || payment.method !== "가상계좌" || !payment.virtualAccount || !payment.secret || !["WAITING_FOR_DEPOSIT", "DONE"].includes(payment.status)) {
      return json(res, 409, { error: "토스 결제 정보가 주문 내용과 일치하지 않습니다." });
    }

    const confirmed = {
      ...record,
      paymentKey: payment.paymentKey,
      secret: payment.secret,
      status: payment.status === "DONE" ? "PAID" : "WAITING_FOR_DEPOSIT",
      virtualAccount: payment.virtualAccount,
      confirmedAt: new Date().toISOString()
    };
    await writeRecord(`${keyPrefix}:${record.participantId}`, confirmed);
    await writeRecord(`${keyPrefix}:order:${orderId}`, confirmed);
    return json(res, 200, { account: publicAccount(confirmed, true) });
  } catch (error) {
    console.error("Toss payment confirmation error:", error.message);
    return json(res, error.statusCode || 502, { error: error.message });
  }
};
