// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Web3Nexus - ETH staking vault with tiered yield and the NEX utility token
 * @notice A single contract serving two roles:
 *
 *         1. An ERC-20 token (NEX) used as the reward asset.
 *         2. A staking vault that accepts native ETH as collateral.
 *
 *         Users stake ETH and pick a lockup tier. Longer lockups earn a higher yield
 *         multiplier. Rewards accrue per second and are paid as newly minted NEX, bounded
 *         by a hard supply cap.
 *
 *         Withdrawals are two-phase: `requestWithdrawal` closes a stake and queues its
 *         principal, and `completeWithdrawal` releases the ETH only after a cooldown. The
 *         delay exists so a caller cannot open a stake, manipulate protocol state, and exit
 *         inside a single transaction (the flash-loan pattern).
 *
 * @dev Inherits four OpenZeppelin bases:
 *      - ERC20:           the NEX token itself
 *      - Ownable:         single-owner administrative access control
 *      - ReentrancyGuard: applied to every ETH-moving entry point
 *      - Pausable:        circuit breaker over `stake` and `claimRewards`
 *
 *      This is a reference implementation and has NOT been audited. `emergencyWithdraw`
 *      can sweep user principal, and the owner can mint and burn NEX freely; both are
 *      documented at their definitions. Do not deploy to a public network with real value.
 */
contract Web3Nexus is ERC20, Ownable, ReentrancyGuard, Pausable {

    // ---------------------------------------------------------------------
    // Struct definitions
    // ---------------------------------------------------------------------

    /**
     * @notice One staking position. An account may hold many.
     * @dev Entries are never removed from the array. A closed stake keeps its slot with
     *      `amount == 0`, which preserves every stake's index as a stable identifier for
     *      the frontend and for `requestWithdrawal`.
     */
    struct Stake {
        uint256 amount;            // Principal in wei; set to 0 once withdrawal is requested
        uint256 startTime;         // Block timestamp the stake was opened
        uint256 lockupDuration;    // Lock length in seconds (0, 7 days, or 30 days)
        uint256 multiplier;        // Yield multiplier in basis points (10000 = 1.0x)
        uint256 lastRewardTime;    // Timestamp accrual was last settled; accrual base
        uint256 accumulatedReward; // Rewards settled but not yet minted
    }

    /**
     * @notice A queued principal repayment awaiting its cooldown.
     * @dev Created by `requestWithdrawal`, settled by `completeWithdrawal`. Like stakes,
     *      entries persist after being claimed so indices stay stable.
     */
    struct CooldownRequest {
        uint256 amount;      // ETH owed to the requester, in wei
        uint256 releaseTime; // Earliest timestamp the payout may be claimed
        bool claimed;        // Guards against claiming the same request twice
    }

    // ---------------------------------------------------------------------
    // State variables
    // ---------------------------------------------------------------------

    /**
     * @notice Global emission rate, owner-adjustable.
     * @dev 18-decimal fixed point. Read as "NEX minted per wei of ETH staked per second,
     *      before the tier multiplier". Divided out by the `10**18` term in `earned`.
     */
    uint256 public rewardRate;

    /**
     * @notice Hard ceiling on NEX total supply: 100 million tokens.
     * @dev Checked before every mint path (`claimRewards` and `adminMint`), so no
     *      combination of yield accrual and administrative action can exceed it.
     */
    uint256 public constant MAX_SUPPLY_CAP = 100_000_000 * 10**18;

    /**
     * @notice Per-address ceiling on concurrent stake: 50 ETH.
     * @dev Enforced against the sum of an account's open stakes, not per transaction, so
     *      the cap cannot be bypassed by splitting a deposit across several stakes.
     */
    uint256 public constant MAX_STAKE_LIMIT = 50 * 10**18;

    /**
     * @notice Delay between requesting a withdrawal and being able to claim the principal.
     * @dev Defaults to 1 minute so the flow is observable in a demo. A production
     *      deployment would use days. Capped at 14 days by `setCooldownPeriod`.
     */
    uint256 public cooldownPeriod = 1 minutes;

    /// @notice All staking positions per account, indexed by stake ID.
    mapping(address => Stake[]) public userStakes;

    /// @notice All withdrawal requests per account, indexed by request ID.
    mapping(address => CooldownRequest[]) public cooldownRequests;

    /**
     * @notice Protocol-wide open stake, in wei.
     * @dev Tracks open principal only — decremented at `requestWithdrawal`, when the stake
     *      closes, rather than at payout. ETH sitting in the cooldown queue is therefore
     *      part of `address(this).balance` but not of `totalStaked`.
     */
    uint256 public totalStaked;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    // The frontend subscribes to these to drive its live activity log; `user` is indexed
    // so a client can filter to a single account without scanning every log.

    /// @notice Emitted when a new stake is opened.
    event Staked(address indexed user, uint256 stakeId, uint256 amount, uint256 lockupDuration, uint256 multiplier);

    /// @notice Emitted when a stake is closed and its principal enters the cooldown queue.
    event WithdrawalRequested(address indexed user, uint256 requestId, uint256 amount, uint256 releaseTime);

    /// @notice Emitted when queued principal is paid out after its cooldown.
    event WithdrawalCompleted(address indexed user, uint256 requestId, uint256 amount);

    /// @notice Emitted when accrued NEX is minted to a staker.
    event RewardsClaimed(address indexed user, uint256 amount);

    /// @notice Emitted when the owner changes the global emission rate.
    event RewardRateUpdated(uint256 oldRate, uint256 newRate);

    /// @notice Emitted when the owner changes the withdrawal cooldown.
    event CooldownPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);

    /// @notice Emitted when the owner sweeps the contract's ETH balance.
    event EmergencyEtherWithdrawn(address indexed owner, uint256 amount);

    /**
     * @notice Deploys the NEX token and opens the vault for staking.
     * @dev Mints a 1,000,000 NEX bootstrap supply (1% of the cap) to the deployer so the
     *      token has circulating supply before any yield is claimed. The deployer becomes
     *      the `Ownable` owner and holds every administrative privilege below.
     * @param _initialRewardRate Starting value for `rewardRate`, in 18-decimal fixed point.
     */
    constructor(uint256 _initialRewardRate)
        ERC20("Nexus Token", "NEX")
        Ownable(msg.sender)
    {
        rewardRate = _initialRewardRate;

        _mint(msg.sender, 1_000_000 * 10**decimals());
    }

    // ---------------------------------------------------------------------
    // View functions
    // ---------------------------------------------------------------------

    /**
     * @notice Number of stake slots an account holds.
     * @dev Includes closed stakes (`amount == 0`), since slots are never removed. Callers
     *      iterating this range must skip zero-amount entries. Used by the frontend to
     *      bound its per-index reads of the public `userStakes` mapping.
     * @param account Address to query.
     * @return Length of the account's stake array.
     */
    function getStakesCount(address account) external view returns (uint256) {
        return userStakes[account].length;
    }

    /**
     * @notice Number of withdrawal request slots an account holds.
     * @dev Includes already-claimed requests, for the same reason as `getStakesCount`.
     * @param account Address to query.
     * @return Length of the account's cooldown request array.
     */
    function getCooldownRequestsCount(address account) external view returns (uint256) {
        return cooldownRequests[account].length;
    }

    /**
     * @notice NEX accrued by a single stake, including yield earned since the last settlement.
     * @dev The reward formula is:
     *
     *          reward = (amount x elapsed x rewardRate x multiplier) / (1e18 x 10000)
     *
     *      The two divisors normalize the scaling factors back out: `1e18` for the
     *      fixed-point `rewardRate`, and `10000` for the basis-point `multiplier`. What
     *      remains is a NEX amount in the token's own 18 decimals.
     *
     *      A closed stake (`amount == 0`) stops accruing and reports only what it settled
     *      at close, so principal that is already queued for withdrawal earns nothing.
     *
     *      Accrual is not gated by the lockup — a lockup restricts *withdrawal*, and yield
     *      continues after it expires for as long as the stake stays open.
     *
     *      An out-of-range `stakeId` returns 0 rather than reverting, so a client polling
     *      indices against a stale count degrades gracefully.
     *
     * @param account Owner of the stake.
     * @param stakeId Index into the account's stake array.
     * @return Accrued NEX for this stake, in 18-decimal fixed point.
     */
    function earned(address account, uint256 stakeId) public view returns (uint256) {
        if (stakeId >= userStakes[account].length) return 0;
        Stake memory s = userStakes[account][stakeId];

        if (s.amount == 0) return s.accumulatedReward;

        uint256 timeElapsed = block.timestamp - s.lastRewardTime;

        uint256 newReward = (s.amount * timeElapsed * rewardRate * s.multiplier) / (10**18 * 10000);
        return s.accumulatedReward + newReward;
    }

    /**
     * @notice NEX accrued across every stake an account holds.
     * @dev Drives the dashboard's "cumulative earnings" figure and the amount minted by
     *      `claimRewards`. Cost grows linearly with the account's stake count; an account
     *      holding very many stakes can push this past the block gas limit.
     * @param account Address to query.
     * @return totalEarned Sum of `earned` over all of the account's stakes.
     */
    function totalEarned(address account) public view returns (uint256 totalEarned) {
        uint256 stakesCount = userStakes[account].length;
        for (uint256 i = 0; i < stakesCount; i++) {
            totalEarned += earned(account, i);
        }
    }

    /**
     * @notice ETH currently staked by an account, summed over its open stakes.
     * @dev Closed stakes contribute 0, so this reflects live exposure and is the value the
     *      anti-whale cap is checked against.
     * @param account Address to query.
     * @return total Open principal in wei.
     */
    function totalUserStaked(address account) public view returns (uint256 total) {
        uint256 stakesCount = userStakes[account].length;
        for (uint256 i = 0; i < stakesCount; i++) {
            total += userStakes[account][i].amount;
        }
    }

    // ---------------------------------------------------------------------
    // User actions
    // ---------------------------------------------------------------------

    /**
     * @notice Opens a new stake funded by the ETH sent with the call.
     * @dev Appends a stake rather than merging into an existing one, so each deposit keeps
     *      its own lockup and multiplier. The anti-whale check sums existing open stakes,
     *      which is what stops the cap from being split across several deposits.
     *
     *      Rejects an unrecognized `lockupIndex` instead of defaulting to a tier, so a
     *      client bug cannot silently place funds under terms the user did not pick.
     *
     * @param lockupIndex Lockup tier: 0 = flexible (1.0x), 1 = 7 days (1.5x), 2 = 30 days (2.5x).
     */
    function stake(uint256 lockupIndex) external payable whenNotPaused nonReentrant {
        require(msg.value > 0, "Cannot stake 0 ETH");

        require(totalUserStaked(msg.sender) + msg.value <= MAX_STAKE_LIMIT, "Exceeds anti-whale limit (50 ETH)");

        uint256 duration;
        uint256 multiplier; // Basis points: 10000 = 1.0x

        if (lockupIndex == 0) {
            duration = 0;
            multiplier = 10000; // 1.0x
        } else if (lockupIndex == 1) {
            duration = 7 days;
            multiplier = 15000; // 1.5x
        } else if (lockupIndex == 2) {
            duration = 30 days;
            multiplier = 25000; // 2.5x
        } else {
            revert("Invalid lockup option selection");
        }

        userStakes[msg.sender].push(Stake({
            amount: msg.value,
            startTime: block.timestamp,
            lockupDuration: duration,
            multiplier: multiplier,
            lastRewardTime: block.timestamp,
            accumulatedReward: 0
        }));

        totalStaked += msg.value;

        emit Staked(
            msg.sender, 
            userStakes[msg.sender].length - 1, 
            msg.value, 
            duration, 
            multiplier
        );
    }

    /**
     * @notice Closes a stake and queues its principal for release after the cooldown.
     * @dev Phase one of the two-phase withdrawal. No ETH moves here — the principal is
     *      recorded as a `CooldownRequest` and paid out later by `completeWithdrawal`.
     *      Splitting the exit across two transactions separated by `cooldownPeriod` is what
     *      prevents a caller from entering, influencing protocol state, and exiting atomically.
     *
     *      Order of operations matters: pending yield is settled into `accumulatedReward`
     *      *before* `amount` is zeroed, since `earned` stops accruing once the stake closes.
     *      Settling afterwards would silently discard the final interval's rewards.
     *
     *      Zeroing `amount` is also the double-request guard — a second call on the same
     *      stake ID fails the `amount > 0` check.
     *
     * @param stakeId Index of the stake to close.
     */
    function requestWithdrawal(uint256 stakeId) external nonReentrant {
        require(stakeId < userStakes[msg.sender].length, "Invalid stake index");
        Stake storage s = userStakes[msg.sender][stakeId];

        require(s.amount > 0, "Stake already fully withdrawn");

        require(block.timestamp >= s.startTime + s.lockupDuration, "Stake is still locked under lockup timeline");

        s.accumulatedReward = earned(msg.sender, stakeId);
        s.lastRewardTime = block.timestamp;

        uint256 withdrawAmount = s.amount;
        s.amount = 0;
        totalStaked -= withdrawAmount;

        cooldownRequests[msg.sender].push(CooldownRequest({
            amount: withdrawAmount,
            releaseTime: block.timestamp + cooldownPeriod,
            claimed: false
        }));

        emit WithdrawalRequested(
            msg.sender, 
            cooldownRequests[msg.sender].length - 1, 
            withdrawAmount, 
            block.timestamp + cooldownPeriod
        );
    }

    /**
     * @notice Pays out a queued withdrawal once its cooldown has elapsed.
     * @dev Phase two of the two-phase withdrawal.
     *
     *      Follows checks-effects-interactions: `claimed` is set before the ETH transfer,
     *      so a re-entrant call during the transfer fails the `!req.claimed` check. The
     *      `nonReentrant` modifier is a second, independent guard on the same path.
     *
     *      Uses `call` rather than `transfer` because `transfer`'s fixed 2300 gas stipend
     *      breaks for smart-contract wallets whose receive hooks cost more than that. The
     *      returned success flag is checked, so a failed transfer reverts the whole call
     *      and the request stays claimable.
     *
     * @param requestId Index of the withdrawal request to settle.
     */
    function completeWithdrawal(uint256 requestId) external nonReentrant {
        require(requestId < cooldownRequests[msg.sender].length, "Invalid request index");
        CooldownRequest storage req = cooldownRequests[msg.sender][requestId];

        require(!req.claimed, "Funds already claimed");
        require(block.timestamp >= req.releaseTime, "Cooldown lock is still active");

        req.claimed = true;

        (bool success, ) = payable(msg.sender).call{value: req.amount}("");
        require(success, "ETH withdrawal transfer failed");

        emit WithdrawalCompleted(msg.sender, requestId, req.amount);
    }

    /**
     * @notice Mints all NEX accrued across the caller's stakes.
     * @dev Rewards are minted on demand rather than pre-allocated, so no NEX is created
     *      until a staker asks for it. Each stake is settled in place — `accumulatedReward`
     *      is cleared and `lastRewardTime` advanced — which restarts accrual from now
     *      without disturbing the principal or the lockup.
     *
     *      The supply cap is checked against the *aggregate* claim before minting, so a
     *      claim that would breach the ceiling reverts whole rather than paying out
     *      partially.
     *
     *      Like `totalEarned`, this loops over every stake slot the account holds and
     *      grows more expensive as that array does.
     */
    function claimRewards() external whenNotPaused nonReentrant {
        uint256 totalClaimable = 0;
        uint256 stakesCount = userStakes[msg.sender].length;

        for (uint256 i = 0; i < stakesCount; i++) {
            uint256 reward = earned(msg.sender, i);
            if (reward > 0) {
                totalClaimable += reward;
                userStakes[msg.sender][i].accumulatedReward = 0;
                userStakes[msg.sender][i].lastRewardTime = block.timestamp;
            }
        }

        require(totalClaimable > 0, "No pending rewards to claim");

        require(totalSupply() + totalClaimable <= MAX_SUPPLY_CAP, "Ecosystem Max Inflation Cap reached!");

        _mint(msg.sender, totalClaimable);

        emit RewardsClaimed(msg.sender, totalClaimable);
    }

    // ---------------------------------------------------------------------
    // Owner-only administration
    // ---------------------------------------------------------------------
    // Every function below is gated by `onlyOwner`. Ownership is a single EOA with no
    // timelock or multisig, so these represent the protocol's trust assumptions.

    /**
     * @notice Sets the global emission rate.
     * @dev Applies to future accrual only. Yield already settled into `accumulatedReward`
     *      is unaffected, but any unsettled interval is recomputed at the new rate, since
     *      `earned` reads `rewardRate` at call time rather than storing it per stake.
     * @param _newRate New rate in 18-decimal fixed point.
     */
    function setRewardRate(uint256 _newRate) external onlyOwner {
        uint256 oldRate = rewardRate;
        rewardRate = _newRate;
        emit RewardRateUpdated(oldRate, _newRate);
    }

    /**
     * @notice Sets the delay between requesting and completing a withdrawal.
     * @dev Capped at 14 days so the owner cannot strand user principal behind an
     *      arbitrarily long cooldown. Applies only to requests created after the change —
     *      existing requests keep the `releaseTime` fixed when they were queued.
     * @param _newPeriod New cooldown in seconds, at most 14 days.
     */
    function setCooldownPeriod(uint256 _newPeriod) external onlyOwner {
        require(_newPeriod <= 14 days, "Cooldown period cannot exceed 14 days");
        uint256 oldPeriod = cooldownPeriod;
        cooldownPeriod = _newPeriod;
        emit CooldownPeriodUpdated(oldPeriod, _newPeriod);
    }

    /**
     * @notice Mints NEX directly to an address, outside the staking flow.
     * @dev Subject to `MAX_SUPPLY_CAP`, which is the only limit on this power — the owner
     *      may mint up to the cap at any time and dilute existing holders.
     * @param to Recipient.
     * @param amount NEX to mint, in 18-decimal fixed point.
     */
    function adminMint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= MAX_SUPPLY_CAP, "Ecosystem Max Inflation Cap reached!");
        _mint(to, amount);
    }

    /**
     * @notice Burns NEX from an arbitrary address.
     * @dev Requires no allowance or holder consent. Burning frees headroom under
     *      `MAX_SUPPLY_CAP`, so it is a supply-management lever, not only a cleanup tool.
     * @param from Address to burn from.
     * @param amount NEX to burn, in 18-decimal fixed point.
     */
    function adminBurn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }

    /**
     * @notice Halts `stake` and `claimRewards`.
     * @dev Deliberately does not block `requestWithdrawal` or `completeWithdrawal`: a
     *      paused protocol still lets stakers exit with their principal. Pausing stops new
     *      exposure and new minting, not the exit path.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes staking and reward claims after a pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Transfers the contract's entire ETH balance to the owner.
     * @dev The protocol's largest trust assumption. The balance includes staked principal
     *      and queued withdrawals, not merely surplus, so this can leave stakers unable to
     *      complete their withdrawals. It is kept unrestricted here because this is a
     *      reference implementation; a production version would cap the sweep at
     *      `address(this).balance - totalStaked - queuedWithdrawals` and put it behind a
     *      timelock.
     */
    function emergencyWithdraw() external onlyOwner nonReentrant {
        uint256 contractBalance = address(this).balance;
        (bool success, ) = payable(owner()).call{value: contractBalance}("");
        require(success, "Emergency withdrawal failed");
        emit EmergencyEtherWithdrawn(owner(), contractBalance);
    }
}
