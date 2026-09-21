    private static void handleLiveFireResult(
            Context context,
            AutoDeductionScheduler scheduler,
            AutoDeductionScheduler.FireResult result,
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            String timeHhmm,
            long recurrenceGeneration,
            String operationVersion,
            int fireRetryCount
    ) {
        if (shouldNotifyJavascript(result)) {
            notifyJavascript(
                    context, medicationId, doseId, calendarDate, scheduledAt, amount);
        }

        if (result.allowsRecurrence()) {
            AutoDeductionStockStore.AutoApplyResult stockResult =
                    new AutoDeductionStockStore(context).applyAutoDeduction(
                            medicationId, doseId, calendarDate, amount);
            if (!stockResult.ok) {
                Log.e(TAG, "live fire native stock apply failed: "
                        + medicationId + "/" + doseId + "/" + calendarDate
                        + " — " + stockResult.error);
                if (shouldScheduleStockRetry(result, fireRetryCount)) {
                    boolean retryScheduled = scheduler.scheduleFireRetry(
                            medicationId, doseId, calendarDate, scheduledAt, amount,
                            timeHhmm, recurrenceGeneration, operationVersion,
                            fireRetryCount + 1);
                    if (retryScheduled) {
                        Log.w(TAG, "live fire stock failure — retry #"
                                + (fireRetryCount + 1) + " scheduled");
                    }
                }
                return;
            }
            scheduler.clearIndependentFireRetryEvidenceAfterStock(
                    medicationId, doseId, calendarDate);