describe('ApprovalEngine', () => {
  it('handles empty approver list', () => {
    const engine = new ApprovalEngine();
    engine.setApprovers([]);
    expect(engine.getNextApprover()).toBeNull();
  });
});