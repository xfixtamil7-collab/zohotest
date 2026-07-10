import { prisma } from '../prisma';
import { QueueService } from '../queue';
import { SessionService } from '../services/session';

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

    console.log('\n🎉 ALL CORE PIPELINE TESTS COMPLETED SUCCESSFULLY! 🎉');
  } catch (error) {
    console.error('\n❌ Integration Test Failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTestFlow();
