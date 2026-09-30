const crypto = require("node:crypto");
const {
  decryptRefundAccount,
  keyPrefix,
  participants,
  readGroupState,
  readRecord,
  redisCommand,
  tossRequest,
  writeGroupState,
  writeRecord
} = require("./virtual-accounts");

async function saveParticipantRecord(record) {
  await writeRecord(`${keyPrefix}:${record.participantId}`, record);
  await writeRecord(`${keyPrefix}:order:${record.orderId}`, record);
}

async function cancelGroupForMissedDeposit(triggerParticipantId) {
  const currentState = await readGroupState();
  if (currentState.status === "ACTIVE") {
    await writeGroupState({
      status: "CANCELING",
      reason: "MISSED_DEPOSIT",
      triggerParticipantId,
      canceledAt: new Date().toISOString()
    });
  }

  const lockKey = `${keyPrefix}:group-cancel-lock`;
  const lockToken = crypto.randomUUID();
  const locked = await redisCommand(["SET", lockKey, lockToken, "NX", "EX", "60"]);
  if (locked !== "OK") throw new Error("공동배달 취소 처리가 진행 중입니다.");

  try {
    for (const participantId of Object.keys(participants)) {
      const record = await readRecord(`${keyPrefix}:${participantId}`);
      if (!record || record.status === "REFUNDED" || record.status === "CANCELED") continue;

      if (record.status === "PAID" || record.status === "REFUNDING" || record.status === "REFUND_FAILED") {
        if (!record.paymentKey || !record.encryptedRefundAccount) {
          record.status = "REFUND_FAILED";
          record.refundStatus = "FAILED";
          await saveParticipantRecord(record);
          throw new Error(`참여자 ${participantId}님의 환불 정보가 없어 자동 환불할 수 없습니다.`);
        }

        record.status = "REFUNDING";
        record.refundStatus = "PENDING";
        await saveParticipantRecord(record);
        try {
          await tossRequest(`/v1/payments/${encodeURIComponent(record.paymentKey)}/cancel`, {
            method: "POST",
            headers: { "Idempotency-Key": `missed-deposit-${record.orderId}` },
            body: JSON.stringify({
              cancelReason: "공동배달 참여자 미입금으로 인한 주문 취소",
              refundReceiveAccount: decryptRefundAccount(record.encryptedRefundAccount)
            })
          });
          record.status = "REFUNDED";
          record.refundStatus = "COMPLETED";
          record.refundedAt = new Date().toISOString();
          delete record.refundError;
        } catch (error) {
          record.status = "REFUND_FAILED";
          record.refundStatus = "FAILED";
          record.refundError = error.message;
          await saveParticipantRecord(record);
          throw error;
        }
      } else {
        if (record.paymentKey && record.status !== "EXPIRED") {
          try {
            await tossRequest(`/v1/payments/${encodeURIComponent(record.paymentKey)}/cancel`, {
              method: "POST",
              headers: { "Idempotency-Key": `missed-deposit-${record.orderId}` },
              body: JSON.stringify({ cancelReason: "공동배달 참여자 미입금으로 인한 주문 취소" })
            });
          } catch (error) {
            record.status = "CANCEL_FAILED";
            record.cancelError = error.message;
            await saveParticipantRecord(record);
            throw error;
          }
        }
        record.status = "CANCELED";
        record.canceledAt = new Date().toISOString();
      }
      await saveParticipantRecord(record);
    }

    const state = await readGroupState();
    await writeGroupState({ ...state, status: "CANCELED", completedAt: new Date().toISOString() });
  } finally {
    const currentToken = await redisCommand(["GET", lockKey]);
    if (currentToken === lockToken) await redisCommand(["DEL", lockKey]);
  }
}

module.exports = { cancelGroupForMissedDeposit };
