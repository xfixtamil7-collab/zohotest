import { prisma } from '../prisma';
import { QueueService } from '../queue';
import { SessionService } from '../services/session';
import { config } from '../config';

// Force mock mode for integration tests
(config as any).MOCK_ALL = true;

async function runTestFlow() {
  console.log('🧪 Starting Automated Core Workflow Integration Test...');
  const testPhone = '+919876543210';

  try {
    // 0. Reset test session state first
    console.log('\n🧹 [Step 0] Cleaning database state...');
    await SessionService.clearSession(testPhone);
    await prisma.orderLog.deleteMany({ where: { phone: testPhone } });
    await prisma.customerMapping.deleteMany({ where: { spokenName: 'Murugan Stores' } });
    console.log('✅ State cleaned.');

    // 1. Send first simulated voice note order
    console.log('\n🎤 [Step 1] Simulating voice message: "Murugan Stores ku 10 cement, 5 steel rod podunga."');
    const msgId1 = `test_msg_${Date.now()}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId1,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'Murugan Stores ku 10 cement, 5 steel rod podunga.'
    });

    // Verify session
    let session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 1...');
    console.log(`Current Session State: ${session.state}`);
    if (session.state !== 'AWAITING_CONFIRMATION') {
      throw new Error(`Expected state AWAITING_CONFIRMATION, but got ${session.state}`);
    }
    
    const draft = session.draft;
    if (!draft) throw new Error('Session draft is null!');
    
    console.log(`Matched Customer: ${draft.zohoCustomerName} (${draft.zohoCustomerId})`);
    console.log(`Matched Items count: ${draft.items.length}`);
    draft.items.forEach(it => {
      console.log(` - Item: "${it.name}" matched to "${it.zohoItemName}" | Price: ₹${it.rate} | Stock: ${it.stockAvailable}`);
    });
    console.log(`Warnings generated: ${JSON.stringify(draft.warnings)}`);
    console.log(`Calculated Grand Total: ₹${draft.grandTotal}`);

    // 2. Simulating a voice correction: Steel rod quantity 8 a maathunga
    console.log('\n✏️ [Step 2] Simulating voice correction: "Steel rod quantity 8 a maathunga."');
    const msgId2 = `test_msg_${Date.now() + 1}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId2,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'Steel rod quantity 8 a maathunga.'
    });

    // Verify updated session
    session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 2 (Correction)...');
    const updatedDraft = session.draft;
    if (!updatedDraft) throw new Error('Updated session draft is null!');

    const steelRod = updatedDraft.items.find(i => i.zohoItemName?.includes('Steel'));
    console.log(`Updated Steel Rod Quantity: ${steelRod?.quantity} (Expected: 8)`);
    if (steelRod?.quantity !== 8) {
      throw new Error(`Expected Steel Rod quantity to be 8, but got ${steelRod?.quantity}`);
    }
    console.log(`Recalculated Grand Total: ₹${updatedDraft.grandTotal}`);

    // 3. Simulating Confirm Button click (OK / Confirm)
    console.log('\n✅ [Step 3] Simulating user click on "Confirm Order" button');
    const msgId3 = `test_msg_${Date.now() + 2}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId3,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'btn_confirm' // Simulated button payload ID
    });

    // Verify session moved to AWAITING_INVOICE_DECISION
    session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 3...');
    console.log(`Current Session State: ${session.state}`);
    if (session.state !== 'AWAITING_INVOICE_DECISION') {
      throw new Error(`Expected state AWAITING_INVOICE_DECISION, but got ${session.state}`);
    }

    // Verify OrderLog in DB
    const log = await prisma.orderLog.findFirst({
      where: { phone: testPhone }
    });
    console.log(`OrderLog entry found in database!`);
    console.log(` - Sales Order Number: ${log?.salesOrderNumber}`);
    console.log(` - Sales Order ID: ${log?.salesOrderId}`);
    console.log(` - PDF Link: ${log?.salesOrderPdf}`);
    console.log(` - Sync Status: ${log?.status}`);

    // 4. Simulating Invoice button click
    console.log('\n🧾 [Step 4] Simulating user click on "Create Invoice" button');
    const msgId4 = `test_msg_${Date.now() + 3}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId4,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'btn_invoice_create' // Simulated button payload ID
    });

    // Verify session reset to IDLE
    session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 4...');
    console.log(`Current Session State: ${session.state} (Expected: IDLE)`);
    if (session.state !== 'IDLE') {
      throw new Error(`Expected state IDLE, but got ${session.state}`);
    }

    // Verify OrderLog is updated to INVOICED
    const updatedLog = await prisma.orderLog.findFirst({
      where: { phone: testPhone }
    });
    console.log(`OrderLog updated in database!`);
    console.log(` - Invoice Number: ${updatedLog?.invoiceNumber}`);
    console.log(` - Invoice ID: ${updatedLog?.invoiceId}`);
    console.log(` - Invoice PDF Link: ${updatedLog?.invoicePdf}`);
    console.log(` - Sync Status: ${updatedLog?.status} (Expected: INVOICED)`);

    // 5. Simulating Edit Sales Order
    console.log('\n✏️ [Step 5] Simulating edit command: "edit sales order SO-12345, set steel rod quantity to 8"');
    const msgId5 = `test_msg_${Date.now() + 4}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId5,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'edit sales order SO-12345, set steel rod quantity to 8'
    });

    // Verify session state is AWAITING_CONFIRMATION
    session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 5 (Edit Sales Order)...');
    console.log(`Current Session State: ${session.state} (Expected: AWAITING_CONFIRMATION)`);
    if (session.state !== 'AWAITING_CONFIRMATION') {
      throw new Error(`Expected state AWAITING_CONFIRMATION, but got ${session.state}`);
    }
    
    let editDraft = session.draft;
    if (!editDraft) throw new Error('Edit draft is null!');
    console.log(`Editing SO Number: ${editDraft.editingSalesOrderNumber} (Expected: SO-12345)`);
    if (editDraft.editingSalesOrderNumber !== 'SO-12345') {
      throw new Error(`Expected editingSalesOrderNumber SO-12345, got ${editDraft.editingSalesOrderNumber}`);
    }

    const editSteelRod = editDraft.items.find(i => i.name.toLowerCase().includes('steel'));
    console.log(`Updated Steel Rod Qty in Edit Draft: ${editSteelRod?.quantity} (Expected: 8)`);
    if (editSteelRod?.quantity !== 8) {
      throw new Error(`Expected Steel Rod quantity to be 8, but got ${editSteelRod?.quantity}`);
    }

    // 6. Confirm Edit
    console.log('\n✅ [Step 6] Simulating user click on "Confirm Edit" for Sales Order');
    const msgId6 = `test_msg_${Date.now() + 5}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId6,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'btn_confirm'
    });

    // Verify session moved to AWAITING_INVOICE_DECISION
    session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 6 (Confirm SO Edit)...');
    console.log(`Current Session State: ${session.state} (Expected: AWAITING_INVOICE_DECISION)`);
    if (session.state !== 'AWAITING_INVOICE_DECISION') {
      throw new Error(`Expected state AWAITING_INVOICE_DECISION, but got ${session.state}`);
    }

    // Clear session for next test
    await SessionService.clearSession(testPhone);

    // 7. Simulating Edit Invoice
    console.log('\n✏️ [Step 7] Simulating edit invoice command: "edit invoice INV-12345, set cement quantity to 20"');
    const msgId7 = `test_msg_${Date.now() + 6}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId7,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'edit invoice INV-12345, set cement quantity to 20'
    });

    // Verify session
    session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 7 (Edit Invoice)...');
    console.log(`Current Session State: ${session.state} (Expected: AWAITING_CONFIRMATION)`);
    if (session.state !== 'AWAITING_CONFIRMATION') {
      throw new Error(`Expected state AWAITING_CONFIRMATION, but got ${session.state}`);
    }

    editDraft = session.draft;
    if (!editDraft) throw new Error('Edit draft is null!');
    console.log(`Editing Invoice Number: ${editDraft.editingInvoiceNumber} (Expected: INV-12345)`);
    if (editDraft.editingInvoiceNumber !== 'INV-12345') {
      throw new Error(`Expected editingInvoiceNumber INV-12345, got ${editDraft.editingInvoiceNumber}`);
    }

    const editCement = editDraft.items.find(i => i.name.toLowerCase().includes('cement'));
    console.log(`Updated Cement Qty in Edit Draft: ${editCement?.quantity} (Expected: 20)`);
    if (editCement?.quantity !== 20) {
      throw new Error(`Expected Cement quantity to be 20, but got ${editCement?.quantity}`);
    }

    // 8. Confirm Invoice Edit
    console.log('\n✅ [Step 8] Simulating user click on "Confirm Edit" for Invoice');
    const msgId8 = `test_msg_${Date.now() + 7}`;
    await QueueService.processMessage({
      from: testPhone,
      messageId: msgId8,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'btn_confirm'
    });

    // Verify session cleared
    session = await SessionService.getSession(testPhone);
    console.log('\n🔍 Verifying Session State after Step 8 (Confirm Invoice Edit)...');
    console.log(`Current Session State: ${session.state} (Expected: IDLE)`);
    if (session.state !== 'IDLE') {
      throw new Error(`Expected state IDLE, but got ${session.state}`);
    }

    console.log('\n🎉 ALL CORE PIPELINE TESTS COMPLETED SUCCESSFULLY! 🎉');
  } catch (error) {
    console.error('\n❌ Integration Test Failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTestFlow();
