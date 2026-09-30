const { readRecord, writeRecord, tossRequest, keyPrefix, readGroupState } = require("./virtual-accounts");
const { cancelGroupForMissedDeposit } = require("./group-cancellation");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = async function tossWebhook(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "POST 요청만 지원합니다." });
  }

  try {
    const { orderId, secret, status } = req.body || {};
    if (!orderId || !secret || !status) {
      return json(res, 400, { error: "필수 웹훅 정보가 없습니다." });
    }

    const record = await readRecord(`${keyPrefix}:order:${orderId}`);
    if (!record || record.orderId !== orderId || typeof record.secret !== "string") {
      return json(res, 404, { error: "등록된 가상계좌 주문을 찾을 수 없습니다." });
    }
    const expected = Buffer.from(record.secret);
    const provided = Buffer.from(String(secret));
    if (expected.length !== provided.length || !require("node:crypto").timingSafeEqual(expected, provided)) {
      return json(res, 401, { error: "웹훅 검증에 실패했습니다." });
    }

    if (status === "DONE") {
      const payment = await tossRequest(`/v1/payments/orders/${encodeURIComponent(orderId)}`);
      if (payment.status !== "DONE" || payment.method !== "가상계좌" || payment.totalAmount !== record.amount || payment.orderId !== orderId) {
        return json(res, 409, { error: "토스 결제 상태 또는 입금 금액이 일치하지 않습니다." });
      }
      record.status = "PAID";
      record.paidAt = payment.approvedAt || new Date().toISOString();
    } else if (status === "WAITING_FOR_DEPOSIT") {
      record.status = "WAITING_FOR_DEPOSIT";
    } else if (status === "CANCELED" || status === "EXPIRED") {
      record.status = status;
    } else {
      return json(res, 400, { error: "처리할 수 없는 가상계좌 상태입니다." });
    }

    await writeRecord(`${keyPrefix}:${record.participantId}`, record);
    await writeRecord(`${keyPrefix}:order:${orderId}`, record);
    if (status === "EXPIRED" || (await readGroupState()).status !== "ACTIVE") {
      await cancelGroupForMissedDeposit(record.participantId);
    }
    return json(res, 200, { received: true });
  } catch (error) {
    console.error("Toss webhook error:", error.message);
    return json(res, 500, { error: "웹훅 처리를 완료하지 못했습니다." });
  }
};
