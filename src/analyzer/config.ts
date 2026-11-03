import type { IRetainedMessage, IUsageFamily } from "./types";

export const DYNAMIC_MESSAGE_FAMILIES: IUsageFamily[] = [
	{
		pattern: "billing.interval.*",
		source: "src/server/modules/billing/billing.enums.ts",
		export: "EBillingInterval",
		reason:
			"Billing intervals come from the procedure's validated interval enum.",
	},
	{
		pattern: "enums.productionStatus.*",
		source: "src/server/modules/production/production.enums.ts",
		export: "EProductionStatus",
		reason:
			"Production history renders the procedure's production status enum.",
	},
	{
		pattern: "cashbook.accounts.types.*",
		source: "src/server/modules/payments/payments.enums.ts",
		export: "EPaymentMethod",
		reason: "Cash account types are validated payment methods.",
	},
	{
		pattern: "cashbook.accounts.status.*",
		source: "src/server/modules/cashbook/cashbook.enums.ts",
		export: "ECashAccountStatus",
		reason: "Account rows and filters use the cash account status enum.",
	},
	{
		pattern: "cashbook.source.*",
		source: "src/server/modules/cashbook/cashbook.enums.ts",
		export: "ECashSource",
		reason: "Cashbook rows and source filters use the cash source enum.",
	},
];

export const RETAINED_MESSAGES: IRetainedMessage[] = [];
