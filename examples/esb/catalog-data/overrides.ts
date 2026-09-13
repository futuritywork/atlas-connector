import type { AtlasType } from "@futurity/atlas-connector";

type EntitySelection = {
  name: string;
  path: string;
  description: string;
  mode: "paged" | "direct";
  version: string;
  primaryKey?: { name: string; basis: "inferred" | "documented" };
  columns: string[];
};

type FieldOverride = {
  sourceField?: string;
  sourceFieldReason?: string;
  type?: { from: string; to: AtlasType; reason: string };
  description?: { from: string; to: string; reason: string };
};

// Descriptions strip HTML, decode entities, and collapse whitespace before overrides.
// Sales-order examples corrupt branch keys; the published field table supplies their names.
// Selection and column order are editorial: new upstream fields must not silently
// expand discovery. Keys are inferred from the existing ID/number contracts unless
// their entry explicitly says documented; upstream examples do not prove uniqueness.
// prettier-ignore
export const ENTITY_SELECTION: EntitySelection[] = [
  {"name": "advance_payments", "path": "/purchase/advance-payment", "description": "Advance payments", "mode": "paged", "version": "2.0.0", "primaryKey": {"name": "advancePaymentNum", "basis": "inferred"}, "columns": "advancePaymentNum advancePaymentDate branchID branchName currencyID currencySign supplierID supplierName purchaseNum paymentTotal usedAdvanceTotal additionalInfo statusID statusName hasApproval linkAdvanceNumEsbGoods createdBy".split(" ") },
  {"name": "budget_adjustments", "path": "/budget/budget-adjustment", "description": "Budget adjustments", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "budgetAdjustmentNum", "basis": "inferred"}, "columns": "budgetAdjustmentNum budgetNum adjustmentType coaNo amount transactionDate statusID statusName createdBy costCenter branch".split(" ") },
  {"name": "budget_allocations", "path": "/budget/budget-allocate", "description": "Budget allocations", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "budgetAdjustmentNum", "basis": "inferred"}, "columns": "budgetAdjustmentNum budgetNum transactionDate statusID statusName createdBy".split(" ") },
  {"name": "budgets", "path": "/budgets", "description": "Budgets", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "budgetNum", "basis": "inferred"}, "columns": "budgetNum budgetPlanNum budgetPlanName periodTypeID periodName startPeriod endPeriod statusID statusName createdBy canEdit".split(" ") },
  {"name": "budget_plans", "path": "/budget-plan", "description": "Budget plans", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "budgetPlanNum", "basis": "inferred"}, "columns": "budgetPlanNum budgetPlanName periodTypeID periodType startPeriodDate endPeriodDate additionalInfo createdBy statusID statusName canEdit".split(" ") },
  {"name": "employee_advance_payments", "path": "/employee/employee-advance-payment", "description": "Employee advance payments", "mode": "paged", "version": "2.0.0", "primaryKey": {"name": "employeeAdvanceNum", "basis": "inferred"}, "columns": "employeeAdvanceNum employeeAdvanceDate dueDay employeeAdvanceDueDate employeeCode employeeName branchID branchName currencyID currencySign employeeAdvanceTotal rate statusID statusName additionalInfo".split(" ") },
  {"name": "goods_deliveries", "path": "/inventory/goods-delivery", "description": "Goods deliveries", "mode": "paged", "version": "1.0.0", "columns": "goodsDeliveryNum goodsDeliveryDate transType referenceNumber originBranchID originBranchName destinationBranchID destBranchName customerName additionalInfo statusID statusName".split(" ") },
  {"name": "goods_receipts", "path": "/inventory/goods-receipt", "description": "Goods receipts", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "goodsReceiptNum", "basis": "inferred"}, "columns": "goodsReceiptNum goodsReceiptDate linkGoodsReceiptNumEsbGoods refNum transType additionalInfo branchID branchName locationID statusID statusName sourceName createdBy".split(" ") },
  {"name": "goods_transfer_requests", "path": "/inventory/goods-transfer-request", "description": "Goods transfer requests", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "transferNum", "basis": "inferred"}, "columns": "transferNum transferDate additionalInfo originBranch destinationBranch purchaseRequestNum statusID statusName".split(" ") },
  {"name": "item_journals", "path": "/inventory/item-journal", "description": "Inventory item journals", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "itemJournalNum", "basis": "inferred"}, "columns": "itemJournalNum itemJournalDate branchID branchName locationID locationName additionalInfo statusID statusName".split(" ") },
  {"name": "purposes", "path": "/purpose", "description": "Accounting purposes", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "purposeID", "basis": "inferred"}, "columns": "purposeID purposeName purposeAccount flagActive".split(" ") },
  {"name": "bills_of_material", "path": "/product/bom", "description": "Bills of material", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "bomID", "basis": "inferred"}, "columns": "bomID bomName bomCode bomTypeID bomTypeName productName uomName notes flagActive".split(" ") },
  {"name": "categories", "path": "/product/category", "description": "Product categories", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "categoryID", "basis": "inferred"}, "columns": "categoryID categoryName categoryTypeID categoryTypeName notes flagActive".split(" ") },
  {"name": "branches", "path": "/branch", "description": "Branches available to the authenticated ESB company", "mode": "direct", "version": "1.0.0", "primaryKey": {"name": "branchID", "basis": "inferred"}, "columns": "branchID branchCode branchName".split(" ") },
  {"name": "locations", "path": "/location", "description": "Inventory locations", "mode": "direct", "version": "1.0.0", "primaryKey": {"name": "locationID", "basis": "inferred"}, "columns": "locationID locationName".split(" ") },
  {"name": "cost_centers", "path": "/cost-center", "description": "Cost centers", "mode": "direct", "version": "1.0.0", "primaryKey": {"name": "ID", "basis": "inferred"}, "columns": "ID costCenter costCenterName flagActive createdBy createdDate editedBy editedDate".split(" ") },
  {"name": "customer_pricelists", "path": "/customer-pricelist", "description": "Customer price lists", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "ID", "basis": "inferred"}, "columns": "ID priceDate customerName productName productCode uomName currencyName expireDate price".split(" ") },
  {"name": "customers", "path": "/customer", "description": "Customers", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "customerID", "basis": "inferred"}, "columns": "customerID customerName customerCode customerCategoryID customerCategoryName paymentDueDays address picName picPhone flagActive lockVat".split(" ") },
  {"name": "document_templates", "path": "/document-template", "description": "Document templates", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "requestTemplateID", "basis": "inferred"}, "columns": "requestTemplateID requestTemplateName branchNames flagActive".split(" ") },
  {"name": "pricelists", "path": "/pricelist", "description": "Supplier price lists", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "ID", "basis": "inferred"}, "columns": "ID priceDate supplierName productName productCode unit currencyName price".split(" ") },
  {"name": "products", "path": "/product/list", "description": "Products", "mode": "paged", "version": "2.0.0", "primaryKey": {"name": "productID", "basis": "inferred"}, "columns": "productID productName productCode categoryID subCategoryID subCategoryName bomID bomName categoryTypeID categoryTypeName flagActive categoryName".split(" ") },
  {"name": "subcategories", "path": "/product/sub-category", "description": "Product subcategories", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "subCategoryID", "basis": "inferred"}, "columns": "subCategoryID subCategoryName notes flagActive".split(" ") },
  {"name": "supplier_categories", "path": "/supplier/category/list", "description": "Supplier categories", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "supplierCategoryID", "basis": "inferred"}, "columns": "supplierCategoryID supplierCategoryName flagActive".split(" ") },
  {"name": "suppliers", "path": "/supplier", "description": "Suppliers", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "supplierID", "basis": "inferred"}, "columns": "supplierID supplierName address supplierCode dueDate flagActive contactPerson cellPhone category supplierCategoryID".split(" ") },
  {"name": "units", "path": "/units", "description": "Units of measure", "mode": "direct", "version": "1.0.0", "primaryKey": {"name": "uomID", "basis": "inferred"}, "columns": "uomID uomName".split(" ") },
  {"name": "material_deliveries", "path": "/production/material-delivery", "description": "Production material deliveries", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "materialDeliveryNum", "basis": "inferred"}, "columns": "materialDeliveryNum materialDeliveryDate productionOrderNum branchID branchName statusID statusName".split(" ") },
  {"name": "memorial_journals", "path": "/accounting/memorial-journal", "description": "Memorial journals", "mode": "paged", "version": "2.0.0", "primaryKey": {"name": "memorialJournalNum", "basis": "documented"}, "columns": "memorialJournalNum memorialJournalDate additionalInfo statusID statusName createdBy approval".split(" ") },
  {"name": "production_orders", "path": "/production/production-order", "description": "Production orders", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "productionOrderNum", "basis": "inferred"}, "columns": "productionOrderNum productionOrderDate branchID branchName bomTypeID bomTypeName additionalInfo statusID statusName".split(" ") },
  {"name": "production_results", "path": "/production/production-result", "description": "Production results", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "productionResultNum", "basis": "inferred"}, "columns": "productionResultNum productionResultDate branchID branchName productionOrderDetailID productionOrderNum bomID bomName statusID statusName additionalInfo".split(" ") },
  {"name": "purchase_invoices", "path": "/purchase/purchase-invoices", "description": "Purchase invoices", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "purchaseInvoiceNum", "basis": "inferred"}, "columns": "branchID branchName createdBy createdByFullName currencyID currencySign invoiceTotal linkInvoiceNumEsbGoods overDue purchaseInvoiceDate purchaseInvoiceDueDate purchaseInvoiceNum statusID statusName supplierID supplierInvoiceNum supplierName additionalInfo".split(" ") },
  {"name": "purchase_orders", "path": "/purchase/purchase-order", "description": "Purchase orders", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "purchaseNum", "basis": "inferred"}, "columns": "purchaseNum purchaseDate requiredDate branchID branchName supplierID supplierName currencyID currencySign purchaseRequestNums linkPurchaseNumEsbGoods purchaseTotal printedBy printedDate emailedBy emailedDate additionalInfo statusID statusName approval mapSupplierLink".split(" ") },
  {"name": "purchase_requests", "path": "/purchase/purchase-request", "description": "Purchase requests", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "purchaseRequestNum", "basis": "inferred"}, "columns": "purchaseRequestNum purchaseRequestDate requiredDate branchID branchName additionalInfo createdDate statusID statusName requestTemplateID".split(" ") },
  {"name": "purchase_returns", "path": "/purchases/purchase-return", "description": "Purchase returns", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "purchaseReturnNum", "basis": "inferred"}, "columns": "purchaseReturnNum purchaseReturnDate branchID branchName supplierID supplierName statusID statusName".split(" ") },
  {"name": "receipts", "path": "/receipt", "description": "Customer receipts", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "receiptNum", "basis": "inferred"}, "columns": "receiptNum receiptDate branchName customerName paymentType grandTotal additionalInfo statusID statusName hasApproval".split(" ") },
  {"name": "sales_orders", "path": "/sales/product-sales", "description": "Sales orders", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "productSalesNum", "basis": "inferred"}, "columns": "additionalInfo branchID branchName createdBy customerAddress customerID customerName currencySign linkPurchaseNum productSalesTypeID requiredDate statusID statusName productSalesDate productSalesNum productSalesTotal".split(" ") },
  {"name": "simple_manufacturing", "path": "/production/simple-manufacturing", "description": "Simple manufacturing transactions", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "simpleManufacturingNum", "basis": "inferred"}, "columns": "simpleManufacturingNum simpleManufacturingDate branchID branchName bomTypeID bomTypeName bomID bomName bomCode manufacturingQty statusID statusName".split(" ") },
  {"name": "simple_purchases", "path": "/purchase/simple-purchase", "description": "Simple purchase transactions", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "cashPurchaseNum", "basis": "inferred"}, "columns": "cashPurchaseNum cashPurchaseDate branchID branchName supplierID supplierName currencySign cashPurchaseTotal additionalInfo statusID statusName approval".split(" ") },
  {"name": "simple_sales", "path": "/sales/simple-product-sales", "description": "Simple sales transactions", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "simpleProductSalesNum", "basis": "inferred"}, "columns": "simpleProductSalesNum simpleProductSalesDate branchID branchName customerID customerName simpleProductSalesTotal additionalInfo statusID statusName currencySign vatInvoiceNum paymentID paymentName".split(" ") },
  {"name": "simple_transfers", "path": "/simple-transfer", "description": "Simple inventory transfers", "mode": "paged", "version": "1.0.0", "primaryKey": {"name": "simpleTransferNum", "basis": "inferred"}, "columns": "simpleTransferNum simpleTransferDate originLocationName destinationLocationName destinationLocationID additionalInfo statusID statusName".split(" ") },
];

// ESB's optional flag describes its field table, not reliable row nullability.
// Preserve the connector contract: inferred/documented keys are required and all
// other selected fields accept null, including fields optional:false in apidoc.
export const NULLABILITY_POLICY = {
  nonPrimaryKey: true,
};

// Each exception names the source value it overrides, so a changed upstream
// definition cannot be silently hidden by a stale local decision.
// prettier-ignore
export const COLUMN_OVERRIDES: Record<string, Record<string, FieldOverride>> = {
  "advance_payments": {
    "advancePaymentDate": {"type": {"from": "String", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}},
    "purchaseNum": {"description": {"from": "Purchase Number (nullable)", "to": "Purchase Number", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "linkAdvanceNumEsbGoods": {"description": {"from": "Link to ESB Goods Advance Number (nullable)", "to": "Link to ESB Goods Advance Number", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "budget_adjustments": {
    "adjustmentType": {"description": {"from": "Adjustment Type Name (Increase / Decrease)", "to": "Adjustment Type Name: Increase or Decrease", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "transactionDate": {"type": {"from": "String", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}},
  },
  "budget_allocations": {
    "transactionDate": {"type": {"from": "String", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}, "description": {"from": "Transaction Date (YYYY-MM-DD)", "to": "Transaction Date", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "budget_plans": {
    "periodTypeID": {"description": {"from": "Period Type ID (1=Monthly, 2=Yearly)", "to": "Period Type ID: 1 for Monthly, 2 for Yearly", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "statusID": {"description": {"from": "Status ID (1=New, 3=Authorized)", "to": "Status ID: 1 for New, 3 for Authorized", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "employee_advance_payments": {
    "employeeAdvanceNum": {"description": {"from": "Advance payment number (prefix: EA)", "to": "Advance payment number with EA prefix", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "statusID": {"description": {"from": "Status ID (1=New, 2=Rejected, 3=Authorized, 27=Released)", "to": "Status ID: 1 for New, 2 for Rejected, 3 for Authorized, 27 for Released", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "goods_receipts": {
    "goodsReceiptNum": {"type": {"from": "Integer", "to": "string", "reason": "Response examples use string identifiers, not numeric values."}},
  },
  "item_journals": {
    "itemJournalDate": {"type": {"from": "String", "to": "datetime", "reason": "Response examples use ISO timestamps with an offset."}},
  },
  "purposes": {
    "flagActive": {"type": {"from": "Integer", "to": "boolean", "reason": "Response examples use boolean or binary active flags, normalized by EsbBoolean."}},
  },
  "bills_of_material": {
    "flagActive": {"type": {"from": "Integer", "to": "boolean", "reason": "Response examples use boolean or binary active flags, normalized by EsbBoolean."}},
  },
  "categories": {
    "flagActive": {"type": {"from": "Integer", "to": "boolean", "reason": "Response examples use boolean or binary active flags, normalized by EsbBoolean."}},
  },
  "customers": {
    "customerCategoryID": {"type": {"from": "Integer", "to": "string", "reason": "Response examples use string identifiers, not numeric values."}},
    "customerCategoryName": {"description": {"from": "\": \"Testing RTN\",", "to": "Customer Category Name", "reason": "The field-table description contains corrupted example JSON; retain the existing field label."}},
  },
  "document_templates": {
    "flagActive": {"type": {"from": "Integer", "to": "boolean", "reason": "Response examples use boolean or binary active flags, normalized by EsbBoolean."}},
  },
  "pricelists": {
    "priceDate": {"type": {"from": "DATETIME", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}},
  },
  "products": {
    "flagActive": {"type": {"from": "Integer", "to": "boolean", "reason": "Response examples use boolean or binary active flags, normalized by EsbBoolean."}},
    "categoryName": {"sourceField": "result.data.categoryNameCategory", "sourceFieldReason": "The field table calls categoryName categoryNameCategory; response rows use categoryName.", "description": {"from": "Type Name", "to": "", "reason": "The misspelled field is described as Type Name; retain the existing empty description rather than inventing one."}},
  },
  "subcategories": {
    "flagActive": {"type": {"from": "Integer", "to": "boolean", "reason": "Response examples use boolean or binary active flags, normalized by EsbBoolean."}},
  },
  "supplier_categories": {
    "flagActive": {"type": {"from": "TinyInteger", "to": "boolean", "reason": "Response examples use boolean or binary active flags, normalized by EsbBoolean."}, "description": {"from": "Flag setting for Active or not Supplier Category (1 Active, 0 Not Active)", "to": "Flag setting for Active or not Supplier Category: 1 Active, 0 Not Active", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "suppliers": {
    "dueDate": {"description": {"from": "Credit Terms (Days)", "to": "Credit Terms in Days", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "memorial_journals": {
    "memorialJournalNum": {"description": {"from": "Memorial Journal number (primary key, prefix: MJ)", "to": "Memorial Journal number with MJ prefix", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "statusID": {"description": {"from": "Status ID (1=New, 2=Rejected, 3=Authorized, 38=Waiting For Approval)", "to": "Status ID: 1 for New, 2 for Rejected, 3 for Authorized, 38 for Waiting For Approval", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "purchase_invoices": {
    "currencySign": {"description": {"from": "Currency Symbol (e.g. \"IDR\", \"USD\")", "to": "Currency Symbol, such as \"IDR\" or \"USD\"", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "linkInvoiceNumEsbGoods": {"description": {"from": "Linked ESB Goods Invoice Number (if any)", "to": "Linked ESB Goods Invoice Number when available", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "purchaseInvoiceDate": {"type": {"from": "String", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}, "description": {"from": "Purchase Invoice Date (Format: yyyy-mm-dd)", "to": "Purchase Invoice Date", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "purchaseInvoiceDueDate": {"type": {"from": "String", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}, "description": {"from": "Purchase Invoice Due Date (Format: yyyy-mm-dd)", "to": "Purchase Invoice Due Date", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "statusName": {"description": {"from": "Status Name (e.g. \"New\", \"Authorized\", \"Rejected\", \"Full Paid\", \"Draft\")", "to": "Status Name, such as \"New\", \"Authorized\", \"Rejected\", \"Full Paid\", or \"Draft\"", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "supplierInvoiceNum": {"description": {"from": "Supplier Invoice Number (if any)", "to": "Supplier Invoice Number when available", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "additionalInfo": {"description": {"from": "Additional information (if any)", "to": "Additional information", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "purchase_orders": {
    "purchaseDate": {"type": {"from": "String", "to": "datetime", "reason": "Response examples use ISO timestamps with an offset."}},
    "requiredDate": {"type": {"from": "String", "to": "datetime", "reason": "Response examples use ISO timestamps with an offset."}},
    "emailedDate": {"type": {"from": "String", "to": "datetime", "reason": "Response examples use ISO timestamps with an offset."}},
  },
  "purchase_returns": {
    "purchaseReturnDate": {"type": {"from": "String", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}, "description": {"from": "Purchase Return Date (Format: yyyy-mm-dd)", "to": "Purchase Return Date", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
    "statusName": {"description": {"from": "Status Name (e.g. \"New\", \"Rejected\", \"Authorized\", \"Full Paid\", \"Draft\")", "to": "Status Name, such as \"New\", \"Rejected\", \"Authorized\", \"Full Paid\", or \"Draft\"", "reason": "Keep the existing concise description without parentheses; nullability and types are represented separately."}},
  },
  "receipts": {
    "receiptNum": {"type": {"from": "Integer", "to": "string", "reason": "Response examples use string identifiers, not numeric values."}},
    "receiptDate": {"type": {"from": "DATETIME", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}},
  },
  "sales_orders": {
    "requiredDate": {"type": {"from": "String", "to": "date", "reason": "Response examples use ISO calendar dates without a time component."}},
    "productSalesDate": {"sourceField": "productSalesDate", "sourceFieldReason": "The response example places this value in the row; the apidoc field path is malformed."},
    "productSalesNum": {"sourceField": "productSalesNum", "sourceFieldReason": "The response example places this value in the row; the apidoc field path is malformed."},
    "productSalesTotal": {"sourceField": "productSalesTotal", "sourceFieldReason": "The response example places this value in the row; the apidoc field path is malformed."},
  },
  "simple_manufacturing": {
    "simpleManufacturingDate": {"type": {"from": "String", "to": "datetime", "reason": "Response examples use ISO timestamps with an offset."}},
  },
  "simple_sales": {
    "simpleProductSalesDate": {"type": {"from": "String", "to": "datetime", "reason": "Response examples use ISO timestamps with an offset."}},
  },
  "simple_transfers": {
    "simpleTransferNum": {"type": {"from": "Integer", "to": "string", "reason": "Response examples use string identifiers, not numeric values."}},
  },
};
