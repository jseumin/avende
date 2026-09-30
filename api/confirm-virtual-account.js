const {
  encryptRefundAccount,
  readGroupState,
  readRecord,
  writeRecord,
  tossRequest,
  publicAccount,
  keyPrefix
} = require("./virtual-accounts");
const { cancelGroupForMissedDeposit } = require("./group-cancellation");

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
    if ((await readGroupState()).status !== "ACTIVE") {
      return json(res, 409, { error: "미입금으로 이미 취소된 공동배달입니다." });
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

    const { refundReceiveAccount, ...virtualAccount } = payment.virtualAccount;
    const encryptedRefundAccount = encryptRefundAccount(refundReceiveAccount);
    const confirmed = {
      ...record,
      paymentKey: payment.paymentKey,
      secret: payment.secret,
      status: payment.status === "DONE" ? "PAID" : "WAITING_FOR_DEPOSIT",
      virtualAccount,
      encryptedRefundAccount,
      confirmedAt: new Date().toISOString()
    };
    await writeRecord(`${keyPrefix}:${record.participantId}`, confirmed);
    await writeRecord(`${keyPrefix}:order:${orderId}`, confirmed);

    if (payment.status === "WAITING_FOR_DEPOSIT" && !encryptedRefundAccount) {
      try {
        await tossRequest(`/v1/payments/${encodeURIComponent(payment.paymentKey)}/cancel`, {
          method: "POST",
          body: JSON.stringify({ cancelReason: "자동 환불 정보가 설정되지 않아 가상계좌 발급 취소" })
        });
      } catch (error) {
        confirmed.status = "CANCEL_FAILED";
        confirmed.cancelError = error.message;
        await writeRecord(`${keyPrefix}:${record.participantId}`, confirmed);
        await writeRecord(`${keyPrefix}:order:${orderId}`, confirmed);
        throw error;
      }
      confirmed.status = "CANCELED";
      await writeRecord(`${keyPrefix}:${record.participantId}`, confirmed);
      await writeRecord(`${keyPrefix}:order:${orderId}`, confirmed);
      return json(res, 503, { error: "토스 상점에서 가상계좌 환불 정보 입력을 켠 뒤 다시 발급해 주세요." });
    }

    if ((await readGroupState()).status !== "ACTIVE") {
      await cancelGroupForMissedDeposit(record.participantId);
      return json(res, 409, { error: "공동배달 취소가 진행되어 가상계좌도 취소·환불했습니다." });
    }
    if (payment.status === "DONE" && !encryptedRefundAccount) {
      return json(res, 409, { error: "환불 계좌 정보를 받지 못했습니다. 토스 상점 설정을 확인하고 운영자에게 문의해 주세요." });
    }
    return json(res, 200, { account: publicAccount(confirmed, true) });
  } catch (error) {
    console.error("Toss payment confirmation error:", error.message);
    return json(res, error.statusCode || 502, { error: error.message });
  }
};
