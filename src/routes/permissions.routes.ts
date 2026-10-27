import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/security.middleware';
import {
  getPermissionGroups,
  createPermissionGroup,
  updatePermissionGroup,
  deletePermissionGroup,
} from '../controllers/permissions.controller';

const router = Router();

router.use(authenticate, authorize(['admin', 'super_admin']));

router.get('/', getPermissionGroups);
router.post('/', createPermissionGroup);
router.put('/:id', updatePermissionGroup);
router.delete('/:id', deletePermissionGroup);

export default router;
